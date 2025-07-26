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
const redis = Redis.createClient(process.env.REDIS_URL || 'redis://localhost:6379');

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
    browser = await puppeteer.launch({
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
    });
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

      const teeTimes = (response.data.tee_times || response.data).map(slot => ({
        time: slot.start_time || slot.time,
        price: parseFloat(slot.rate?.price || slot.price || slot.green_fee || 50),
        availableSlots: parseInt(slot.available_spots || slot.remaining_spots || 4),
        holes: parseInt(slot.holes || slot.nb_holes || 18),
        isHotDeal: slot.is_deal || slot.special_rate || false,
      })).filter(time => time.time);

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
    // Fallback to demo data for unknown booking systems
    return [];
  }
}

// API Routes

// Get all courses
app.get('/api/courses', (req, res) => {
  res.json({
    success: true,
    data: UTAH_COURSES,
    total: UTAH_COURSES.length
  });
});

// Get tee times for a specific course
app.get('/api/courses/:courseId/teetimes', 
  [
    body('date').optional().isISO8601().withMessage('Date must be in ISO8601 format')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { courseId } = req.params;
      const date = req.query.date || new Date().toISOString().split('T')[0];

      const course = UTAH_COURSES.find(c => c.id === courseId);
      if (!course) {
        return res.status(404).json({
          success: false,
          message: 'Course not found'
        });
      }

      const scraper = await ScraperFactory.createScraper(course.bookingSystem);
      const teeTimes = await scraper.scrapeTeeTimes(course, date);

      res.json({
        success: true,
        data: {
          course: course,
          date: date,
          teeTimes: teeTimes,
          count: teeTimes.length
        }
      });
    } catch (error) {
      console.error('Error fetching tee times:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// Batch get tee times for multiple courses
app.post('/api/courses/batch-teetimes',
  [
    body('courseIds').isArray().withMessage('courseIds must be an array'),
    body('date').optional().isISO8601().withMessage('Date must be in ISO8601 format')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { courseIds, date = new Date().toISOString().split('T')[0] } = req.body;
      
      const results = await Promise.allSettled(
        courseIds.map(async (courseId) => {
          const course = UTAH_COURSES.find(c => c.id === courseId);
          if (!course) return null;

          const scraper = await ScraperFactory.createScraper(course.bookingSystem);
          const teeTimes = await scraper.scrapeTeeTimes(course, date);

          return {
            courseId: course.id,
            courseName: course.name,
            teeTimes: teeTimes,
            count: teeTimes.length
          };
        })
      );

      const data = results
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value);

      res.json({
        success: true,
        data: data,
        date: date,
        totalCourses: data.length
      });
    } catch (error) {
      console.error('Error batch fetching tee times:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
);

// Analytics endpoint
app.post('/api/events', 
  [
    body('event').notEmpty().withMessage('Event name is required'),
    body('user_id').notEmpty().withMessage('User ID is required')
  ],
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      // In a real app, you'd store this in a database
      console.log('Analytics Event:', req.body);

      res.json({
        success: true,
        message: 'Event tracked successfully'
      });
    } catch (error) {
      console.error('Error tracking event:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Scheduled tasks
// Run tee time updates every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('Running scheduled tee time updates...');
  
  for (const course of UTAH_COURSES) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const scraper = await ScraperFactory.createScraper(course.bookingSystem);
      
      // Update today and tomorrow
      await Promise.all([
        scraper.scrapeTeeTimes(course, today),
        scraper.scrapeTeeTimes(course, tomorrow)
      ]);
      
      console.log(`Updated tee times for ${course.name}`);
    } catch (error) {
      console.error(`Error updating ${course.name}:`, error);
    }
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Start server
async function startServer() {
  try {
    await redis.connect();
    console.log('Connected to Redis');
    
    await initBrowser();
    
    app.listen(PORT, () => {
      console.log(`Utah Golf API server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  if (browser) {
    await browser.close();
  }
  
  await redis.disconnect();
  process.exit(0);
});

startServer();