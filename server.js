const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const cron = require('node-cron');
const Redis = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// Redis client for caching
const redis = Redis.createClient({
  url: process.env.REDIS_URL
});

redis.on('error', (err) => console.error('Redis Client Error', err));

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Browser instance for scraping
let browser;

// Initialize browser
async function initBrowser() {
  try {
    const puppeteerOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    };

    // Use custom Chrome path if provided
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteer.launch(puppeteerOptions);
    console.log('Browser initialized');
  } catch (error) {
    console.error('Error initializing browser:', error);
  }
}

// Utah golf courses data
const UTAH_COURSES = [
  {
    id: 'bonneville',
    name: 'Bonneville Golf Course',
    bookingUrl: 'https://foreupsoftware.com/index.php/booking/20287/5495',
    bookingSystem: 'foreup',
    city: 'Salt Lake City'
  },
  {
    id: 'mountain-dell-canyon',
    name: 'Mountain Dell Golf Course - Canyon',
    bookingUrl: 'https://foreupsoftware.com/index.php/booking/20287/5496',
    bookingSystem: 'foreup',
    city: 'Salt Lake City'
  },
  {
    id: 'river-oaks',
    name: 'River Oaks Golf Course',
    bookingUrl: 'https://www.golfnow.com/tee-times/facility/19765-river-oaks-golf-course/search',
    bookingSystem: 'golfnow',
    city: 'Sandy'
  },
  {
    id: 'thanksgiving-point',
    name: 'Thanksgiving Point Golf Club',
    bookingUrl: 'https://www.golfnow.com/tee-times/facility/1126-thanksgiving-point-golf-club/search',
    bookingSystem: 'golfnow',
    city: 'Lehi'
  },
  {
    id: 'meadowbrook',
    name: 'Meadowbrook Golf Course',
    bookingUrl: 'https://www.chronogolf.com/course/meadowbrook-golf-course',
    bookingSystem: 'chronogolf',
    city: 'Taylorsville'
  }
  // Add more courses as needed
];

// Scraper implementations
class ScraperFactory {
  static async createScraper(bookingSystem) {
    switch (bookingSystem) {
      case 'golfnow':
        return new GolfNowScraper();
      case 'foreup':
        return new ForeUpScraper();
      case 'chronogolf':
        return new ChronogolfScraper();
      default:
        return new GenericScraper();
    }
  }
}

class GolfNowScraper {
  async scrapeTeeTimes(course, date) {
    const cacheKey = `golfnow:${course.id}:${date}`;
    
    try {
      // Check cache first
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        return JSON.parse(cachedData);
      }

      if (!browser) {
        console.error('Browser not initialized');
        return [];
      }

      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      
      const url = `${course.bookingUrl}?date=${date}`;
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForTimeout(2000);

      const teeTimes = await page.evaluate(() => {
        const times = [];
        const teeTimeElements = document.querySelectorAll('.tee-time-card, .teetime-row, [data-teetime-id]');
        
        teeTimeElements.forEach(element => {
          const timeText = element.querySelector('.time, .teetime-time')?.textContent?.trim();
          const priceText = element.querySelector('.price, .rate')?.textContent?.trim();
          const slotsText = element.querySelector('.slots, .available')?.textContent?.trim();
          
          if (timeText && priceText) {
            const priceMatch = priceText.match(/\$?(\d+(?:\.\d{2})?)/);
            const slotsMatch = slotsText?.match(/(\d+)/);
            
            times.push({
              time: timeText,
              price: priceMatch ? parseFloat(priceMatch[1]) : null,
              availableSlots: slotsMatch ? parseInt(slotsMatch[1]) : 4,
              isHotDeal: element.classList.contains('hot-deal') || element.textContent.toLowerCase().includes('hot'),
            });
          }
        });
        
        return times;
      });

      await page.close();

      // Cache for 15 minutes
      await redis.setex(cacheKey, 900, JSON.stringify(teeTimes));
      
      return teeTimes;
    } catch (error) {
      console.error(`GolfNow scraper error for ${course.name}:`, error);
      return [];
    }
  }
}

class ForeUpScraper {
  async scrapeTeeTimes(course, date) {
    const cacheKey = `foreup:${course.id}:${date}`;
    
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        return JSON.parse(cachedData);
      }

      // Extract booking and schedule IDs from URL
      const match = course.bookingUrl.match(/booking\/(\d+)\/(\d+)/);
      if (!match) return [];

      const [, bookingId, scheduleId] = match;
      const apiUrl = `https://foreupsoftware.com/index.php/api/booking/times`;
      
      const response = await axios.get(apiUrl, {
        params: {
          time: 'all',
          date: date,
          holes: 'all',
          players: '0',
          booking_class: bookingId,
          schedule_id: scheduleId,
          'schedule_ids[]': scheduleId,
          specials_only: '0',
          api_key: 'no_limits'
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 10000
      });

      const teeTimes = response.data.map(slot => ({
        time: slot.time || slot.start_time,
        price: parseFloat(slot.green_fee || slot.price || 50),
        availableSlots: parseInt(slot.available_spots || slot.max_players || 4),
        holes: parseInt(slot.holes || 18),
        isHotDeal: slot.special === true || slot.is_special === true,
      })).filter(time => time.time);

      await redis.setex(cacheKey, 900, JSON.stringify(teeTimes));
      return teeTimes;
    } catch (error) {
      console.error(`ForeUp scraper error for ${course.name}:`, error);
      return [];
    }
  }
}

class ChronogolfScraper {
  async scrapeTeeTimes(course, date) {
    const cacheKey = `chronogolf:${course.id}:${date}`;
    
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        return JSON.parse(cachedData);
      }

      const courseSlug = course.bookingUrl.match(/course\/([^/?]+)/)?.[1];
      if (!courseSlug) return [];

      const apiUrl = `https://www.chronogolf.com/marketplace/clubs/${courseSlug}/tee-times`;
      
      const response = await axios.get(apiUrl, {
        params: {
          date: date,
          nb_holes: 18
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 10000
      });

      const teeTimes = response.data.tee_times?.map(slot => ({
        time: slot.start_time,
        price: parseFloat(slot.green_fee || 50),
        availableSlots: parseInt(slot.nb_bookable_slots || 4),
        holes: parseInt(slot.nb_holes || 18),
        isHotDeal: slot.is_deal || false,
      })) || [];

      await redis.setex(cacheKey, 900, JSON.stringify(teeTimes));
      return teeTimes;
    } catch (error) {
      console.error(`Chronogolf scraper error for ${course.name}:`, error);
      return [];
    }
  }
}

class GenericScraper {
  async scrapeTeeTimes(course, date) {
    // Fallback implementation that returns sample data
    console.log(`Using generic scraper for ${course.name}`);
    return [
      {
        time: '7:00 AM',
        price: 45,
        availableSlots: 4,
        holes: 18,
        isHotDeal: false
      },
      {
        time: '7:30 AM',
        price: 45,
        availableSlots: 2,
        holes: 18,
        isHotDeal: false
      }
    ];
  }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    redis: redis.isOpen ? 'connected' : 'disconnected',
    browser: browser ? 'initialized' : 'not initialized'
  });
});

// Get all courses
app.get('/api/courses', (req, res) => {
  res.json(UTAH_COURSES);
});

// Get course by ID
app.get('/api/courses/:id', (req, res) => {
  const course = UTAH_COURSES.find(c => c.id === req.params.id);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  res.json(course);
});

// Get tee times for a course
app.get('/api/tee-times/:courseId', [
  body('date').optional().isISO8601().toDate()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const course = UTAH_COURSES.find(c => c.id === req.params.courseId);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const date = req.query.date || new Date().toISOString().split('T')[0];
  
  try {
    const scraper = await ScraperFactory.createScraper(course.bookingSystem);
    const teeTimes = await scraper.scrapeTeeTimes(course, date);
    
    res.json({
      course: course,
      date: date,
      teeTimes: teeTimes
    });
  } catch (error) {
    console.error('Error fetching tee times:', error);
    res.status(500).json({ error: 'Failed to fetch tee times' });
  }
});

// Search tee times across all courses
app.get('/api/search/tee-times', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const maxPrice = req.query.maxPrice ? parseFloat(req.query.maxPrice) : null;
  const minSlots = req.query.minSlots ? parseInt(req.query.minSlots) : 1;
  
  try {
    const allResults = await Promise.all(
      UTAH_COURSES.map(async (course) => {
        const scraper = await ScraperFactory.createScraper(course.bookingSystem);
        const teeTimes = await scraper.scrapeTeeTimes(course, date);
        
        // Filter by criteria
        const filtered = teeTimes.filter(time => {
          if (maxPrice && time.price > maxPrice) return false;
          if (time.availableSlots < minSlots) return false;
          return true;
        });
        
        return {
          course: course,
          teeTimes: filtered
        };
      })
    );
    
    // Filter out courses with no matching tee times
    const results = allResults.filter(result => result.teeTimes.length > 0);
    
    res.json({
      date: date,
      filters: {
        maxPrice: maxPrice,
        minSlots: minSlots
      },
      results: results
    });
  } catch (error) {
    console.error('Error searching tee times:', error);
    res.status(500).json({ error: 'Failed to search tee times' });
  }
});

// Refresh cache for a specific course
app.post('/api/refresh/:courseId', async (req, res) => {
  const course = UTAH_COURSES.find(c => c.id === req.params.courseId);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }
  
  const date = req.body.date || new Date().toISOString().split('T')[0];
  const cacheKey = `${course.bookingSystem}:${course.id}:${date}`;
  
  try {
    // Delete cache entry
    await redis.del(cacheKey);
    
    // Fetch fresh data
    const scraper = await ScraperFactory.createScraper(course.bookingSystem);
    const teeTimes = await scraper.scrapeTeeTimes(course, date);
    
    res.json({
      message: 'Cache refreshed',
      course: course,
      date: date,
      teeTimes: teeTimes
    });
  } catch (error) {
    console.error('Error refreshing cache:', error);
    res.status(500).json({ error: 'Failed to refresh cache' });
  }
});

// Schedule cache warming (optional)
cron.schedule('0 6 * * *', async () => {
  console.log('Running scheduled cache warming...');
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  
  for (const course of UTAH_COURSES) {
    try {
      const scraper = await ScraperFactory.createScraper(course.bookingSystem);
      await scraper.scrapeTeeTimes(course, today);
      await scraper.scrapeTeeTimes(course, tomorrow);
    } catch (error) {
      console.error(`Cache warming failed for ${course.name}:`, error);
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
async function startServer() {
  try {
    await redis.connect();
    console.log('Connected to Redis');
    
    await initBrowser();
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  if (browser) {
    await browser.close();
  }
  
  await redis.disconnect();
  process.exit(0);
});

startServer();