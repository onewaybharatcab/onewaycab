# One-Way Bhaarat – Complete Deployment & Setup Guide

**One-Way Bhaarat Private Limited**  
Website: one-waybharat.com  
Support: +91-93557 57579 | onewaybharatcab@gmail.com

---

## 📁 File Structure

```
one-waybharat.com/
├── index.html              ← Homepage (main booking page)
├── booking.html            ← Booking form & payment
├── fleet.html              ← Vehicle listing
├── routes.html             ← All India routes
├── about.html              ← About Us
├── contact.html            ← Contact page
├── faq.html                ← FAQ with schema markup
├── blog.html               ← Travel blog
├── policies.html           ← Terms, Privacy, Cancellation, Refund
├── sitemap.xml             ← SEO sitemap
├── robots.txt              ← Search engine rules
├── admin.html              ← Admin dashboard (restrict access)
├── driver.html             ← Driver panel (restrict access)
├── customer.html           ← Customer dashboard
│
├── assets/
│   ├── css/
│   │   └── (additional CSS files if needed)
│   ├── js/
│   │   └── (Google Maps, Razorpay, etc. integration scripts)
│   └── images/
│       ├── logo.png
│       ├── vehicles/
│       └── og-image.jpg   ← Social sharing image
│
├── api/                    ← PHP backend files
│   ├── booking.php
│   ├── otp.php
│   ├── payment.php
│   └── config.php
│
└── database/
    └── schema.sql          ← MySQL database setup
```

---

## 🚀 Step 1: GitHub Repository Setup

```bash
# Initialize repository
git init
git add .
git commit -m "Initial commit – One-Way Bhaarat website v1.0"

# Create GitHub repository at github.com and push
git remote add origin https://github.com/YOUR_USERNAME/one-way-bhaarat.git
git branch -M main
git push -u origin main
```

---

## 🌐 Step 2: cPanel Hosting Deployment

### Upload Files via cPanel File Manager

1. Log into cPanel → **File Manager**
2. Navigate to `public_html/`
3. Upload all HTML, CSS, JS files
4. Upload `sitemap.xml` and `robots.txt` to root

### Or deploy via Git (if hosting supports it):

```bash
# SSH into server
ssh username@your-server.com

# Navigate to public_html
cd public_html

# Clone repository
git clone https://github.com/YOUR_USERNAME/one-way-bhaarat.git .
```

### PHP Backend Setup (cPanel)

1. Go to cPanel → **MySQL Databases**
2. Create database: `owb_database`
3. Create user: `owb_user` with strong password
4. Assign user to database with ALL PRIVILEGES
5. Import `database/schema.sql` via phpMyAdmin

---

## ☁️ Step 3: Cloudflare Setup

### 3.1 Add Site to Cloudflare

1. Create account at cloudflare.com
2. Add site: `one-waybharat.com`
3. Select **Free plan** (or Pro for better features)
4. Update nameservers at your domain registrar to Cloudflare's nameservers

### 3.2 DNS Records

| Type  | Name | Value                        | Proxy |
|-------|------|------------------------------|-------|
| A     | @    | YOUR_SERVER_IP               | ✅    |
| A     | www  | YOUR_SERVER_IP               | ✅    |
| CNAME | mail | mail.your-hosting.com        | ❌    |
| MX    | @    | mail.your-hosting.com        | ❌    |

### 3.3 SSL/TLS Settings

1. Cloudflare → **SSL/TLS** → Set to **Full (Strict)**
2. Enable **Always Use HTTPS**
3. Enable **HSTS** (Strict Transport Security)

### 3.4 Cloudflare Security Settings

```
Security Level: Medium
Bot Fight Mode: ON
Browser Integrity Check: ON
WAF: ON (Free plan includes basic WAF rules)
DDoS Protection: Automatic (included)
```

### 3.5 Cloudflare Performance Settings

```
Auto Minify: ✅ JavaScript, CSS, HTML
Brotli: ON
Caching Level: Standard
Browser Cache TTL: 4 hours
```

### 3.6 Cloudflare Page Rules (Free: 3 rules)

```
Rule 1: one-waybharat.com/admin*
  → Security Level: High

Rule 2: one-waybharat.com/assets/*
  → Cache Level: Cache Everything
  → Browser Cache TTL: 1 month

Rule 3: one-waybharat.com/*
  → Always Use HTTPS
```

---

## 🔑 Step 4: API Key Integration

### 4.1 Google Maps & Places API

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project: "One-Way Bhaarat"
3. Enable APIs:
   - **Maps JavaScript API**
   - **Places API**
   - **Distance Matrix API**
   - **Geocoding API**
4. Create API Key → Restrict to your domain: `one-waybharat.com`
5. Replace `YOUR_GOOGLE_MAPS_API_KEY` in HTML files

```html
<!-- Add to <head> of index.html and booking.html -->
<script src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&libraries=places"></script>
```

```javascript
// Google Places Autocomplete in booking form
const pickupInput = document.getElementById('pickup');
const autocomplete = new google.maps.places.Autocomplete(pickupInput, {
  componentRestrictions: { country: 'in' },
  types: ['geocode', 'establishment']
});
```

### 4.2 Razorpay Integration

1. Create account at [razorpay.com](https://razorpay.com)
2. Get API keys from Dashboard → Settings → API Keys
3. Add to booking.html:

```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

```javascript
const options = {
  key: 'YOUR_RAZORPAY_KEY_ID',
  amount: advanceAmount * 100, // in paise
  currency: 'INR',
  name: 'One-Way Bhaarat Pvt. Ltd.',
  description: 'Cab Booking Advance – ' + bookingId,
  image: 'https://one-waybharat.com/assets/images/logo.png',
  handler: function(response) {
    // Handle successful payment
    confirmBooking(response.razorpay_payment_id, bookingId);
  },
  prefill: {
    name: customerName,
    email: customerEmail,
    contact: customerMobile
  },
  theme: { color: '#FF6B00' }
};
const rzp = new Razorpay(options);
rzp.open();
```

### 4.3 PhonePe Business Integration

1. Apply at [phonepe.com/business](https://phonepe.com/business)
2. After approval, integrate their SDK:

```javascript
// PhonePe payment initiation (server-side PHP required)
// See: https://developer.phonepe.com/v1/docs
```

### 4.4 SMS/OTP Integration (MSG91 or Fast2SMS)

```javascript
// api/otp.php – Send OTP
<?php
$mobile = $_POST['mobile'];
$otp = rand(100000, 999999);

// Store OTP in session/database
$_SESSION['otp_' . $mobile] = $otp;

// Send via MSG91
$url = "https://api.msg91.com/api/v5/otp?template_id=YOUR_TEMPLATE&mobile=91{$mobile}&authkey=YOUR_AUTH_KEY&otp={$otp}";
file_get_contents($url);
echo json_encode(['success' => true]);
?>
```

### 4.5 WhatsApp API (Meta Business API)

1. Create Meta Business account
2. Set up WhatsApp Business API
3. Create message templates for booking confirmation
4. Send automated confirmations on booking

---

## 🗄️ Step 5: MySQL Database Schema

```sql
-- database/schema.sql

CREATE DATABASE IF NOT EXISTS owb_database;
USE owb_database;

-- Bookings table
CREATE TABLE bookings (
  id VARCHAR(20) PRIMARY KEY,
  customer_name VARCHAR(100) NOT NULL,
  customer_mobile VARCHAR(15) NOT NULL,
  customer_email VARCHAR(100),
  pickup_location TEXT NOT NULL,
  drop_location TEXT NOT NULL,
  pickup_date DATE NOT NULL,
  pickup_time TIME NOT NULL,
  return_date DATE,
  trip_type ENUM('oneway','roundtrip','airport') DEFAULT 'oneway',
  vehicle_type ENUM('hatchback','sedan','ertiga','innova') NOT NULL,
  distance_km INT,
  base_fare DECIMAL(10,2),
  driver_allowance DECIMAL(10,2),
  state_tax DECIMAL(10,2),
  gst DECIMAL(10,2),
  toll_charges DECIMAL(10,2),
  total_fare DECIMAL(10,2),
  advance_paid DECIMAL(10,2),
  remaining_amount DECIMAL(10,2),
  payment_gateway VARCHAR(20),
  payment_id VARCHAR(100),
  driver_id VARCHAR(20),
  status ENUM('pending','confirmed','active','completed','cancelled') DEFAULT 'pending',
  special_instructions TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Customers table
CREATE TABLE customers (
  id VARCHAR(20) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  mobile VARCHAR(15) UNIQUE NOT NULL,
  email VARCHAR(100),
  city VARCHAR(100),
  referral_code VARCHAR(20) UNIQUE,
  referred_by VARCHAR(20),
  wallet_balance DECIMAL(10,2) DEFAULT 0,
  total_trips INT DEFAULT 0,
  total_spent DECIMAL(10,2) DEFAULT 0,
  status ENUM('active','inactive','blocked') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drivers table
CREATE TABLE drivers (
  id VARCHAR(20) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  mobile VARCHAR(15) UNIQUE NOT NULL,
  email VARCHAR(100),
  vehicle_type ENUM('hatchback','sedan','ertiga','innova'),
  vehicle_number VARCHAR(20),
  vehicle_model VARCHAR(100),
  license_number VARCHAR(50),
  aadhar_number VARCHAR(20),
  bank_account VARCHAR(30),
  bank_ifsc VARCHAR(15),
  home_city VARCHAR(100),
  rating DECIMAL(3,2) DEFAULT 5.00,
  total_trips INT DEFAULT 0,
  total_earnings DECIMAL(12,2) DEFAULT 0,
  is_online TINYINT DEFAULT 0,
  kyc_status ENUM('pending','verified','rejected') DEFAULT 'pending',
  status ENUM('active','inactive','suspended') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payments table
CREATE TABLE payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id VARCHAR(20),
  amount DECIMAL(10,2),
  gateway VARCHAR(20),
  transaction_id VARCHAR(100),
  status ENUM('pending','success','failed','refunded') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

-- Coupons table
CREATE TABLE coupons (
  code VARCHAR(20) PRIMARY KEY,
  discount_type ENUM('percent','flat'),
  discount_value DECIMAL(10,2),
  max_discount DECIMAL(10,2),
  min_booking_amount DECIMAL(10,2),
  valid_from DATE,
  valid_till DATE,
  usage_limit INT DEFAULT 100,
  used_count INT DEFAULT 0,
  status ENUM('active','expired','disabled') DEFAULT 'active'
);

-- Reviews table
CREATE TABLE reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id VARCHAR(20),
  customer_id VARCHAR(20),
  driver_id VARCHAR(20),
  rating TINYINT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- OTP table (temporary, auto-cleanup)
CREATE TABLE otp_log (
  mobile VARCHAR(15),
  otp VARCHAR(6),
  expires_at TIMESTAMP,
  verified TINYINT DEFAULT 0,
  PRIMARY KEY (mobile)
);
```

---

## 📧 Step 6: Email Setup (cPanel)

1. cPanel → **Email Accounts** → Create:
   - `booking@one-waybharat.com` – for booking confirmations
   - `support@one-waybharat.com` – for customer support
   - `noreply@one-waybharat.com` – for automated emails

2. Configure SMTP in PHP:

```php
// api/config.php
define('SMTP_HOST', 'mail.one-waybharat.com');
define('SMTP_USER', 'booking@one-waybharat.com');
define('SMTP_PASS', 'YOUR_EMAIL_PASSWORD');
define('SMTP_PORT', 587);
```

---

## 🔒 Step 7: Security Hardening

### .htaccess (place in public_html/)

```apache
# Force HTTPS
RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]

# Protect sensitive files
<Files "*.php">
  Order Deny,Allow
  Deny from all
</Files>

# Allow API folder
<Directory /api>
  Order Allow,Deny
  Allow from all
</Directory>

# Security headers
Header always set X-Content-Type-Options nosniff
Header always set X-Frame-Options SAMEORIGIN
Header always set X-XSS-Protection "1; mode=block"
Header always set Referrer-Policy "strict-origin-when-cross-origin"

# Block access to admin panel from non-whitelisted IPs
<Files "admin.html">
  Order Deny,Allow
  Deny from all
  Allow from YOUR_OFFICE_IP
</Files>

# Compression
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript
</IfModule>

# Browser Caching
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/jpg "access plus 1 month"
  ExpiresByType image/png "access plus 1 month"
  ExpiresByType image/webp "access plus 1 month"
  ExpiresByType text/css "access plus 1 week"
  ExpiresByType application/javascript "access plus 1 week"
</IfModule>
```

---

## 📊 Step 8: Google Analytics & Search Console

### Google Analytics 4

```html
<!-- Add to <head> of all HTML pages -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

### Google Search Console

1. Go to [search.google.com/search-console](https://search.google.com/search-console)
2. Add property: `https://one-waybharat.com`
3. Verify via HTML file or DNS TXT record
4. Submit sitemap: `https://one-waybharat.com/sitemap.xml`

---

## ⚡ Step 9: Performance Optimization Checklist

```
✅ Images converted to WebP format
✅ Images lazy-loaded with loading="lazy"
✅ CSS minified (use cssnano or online tool)
✅ JavaScript minified (use terser or online tool)
✅ Google Fonts loaded with preconnect
✅ Cloudflare CDN enabled
✅ Brotli compression enabled in Cloudflare
✅ Browser caching configured
✅ Core Web Vitals: LCP < 2.5s, FID < 100ms, CLS < 0.1
✅ Mobile-first responsive design
✅ Lighthouse score target: 90+
```

---

## 🔍 Step 10: SEO Setup Checklist

```
✅ sitemap.xml submitted to Google Search Console
✅ robots.txt uploaded to root
✅ Meta title & description on all pages
✅ Open Graph tags for social sharing
✅ Schema markup: LocalBusiness, FAQPage, Route
✅ Canonical URLs on all pages
✅ SSL certificate active (HTTPS)
✅ Mobile-friendly test passed
✅ Page speed optimized
✅ Google My Business listing created
✅ NAP consistency: Name, Address, Phone identical everywhere
```

### Local Business Schema (add to index.html)

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "One-Way Bhaarat Private Limited",
  "description": "India's Trusted One-Way Taxi Service – Affordable Outstation Cabs Across India",
  "url": "https://one-waybharat.com",
  "telephone": "+91-9355757579",
  "email": "onewaybharatcab@gmail.com",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "Shop No. 7, Radha Kunj 2",
    "addressLocality": "Ghaziabad",
    "addressRegion": "Uttar Pradesh",
    "postalCode": "203207",
    "addressCountry": "IN"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 28.6692,
    "longitude": 77.4538
  },
  "openingHours": "Mo-Su 00:00-24:00",
  "priceRange": "₹₹",
  "serviceArea": {
    "@type": "Country",
    "name": "India"
  }
}
</script>
```

---

## 📱 Step 11: WhatsApp Business Setup

1. Download WhatsApp Business app
2. Set business name: "One-Way Bhaarat"
3. Set business category: "Travel & Tourism"
4. Add business hours, address, website
5. Create quick replies for common queries:
   - `/rates` – Fare rates
   - `/book` – Booking link
   - `/cancel` – Cancellation policy
   - `/track` – Track booking

---

## 🧪 Step 12: Testing Checklist

```
FUNCTIONALITY
✅ Homepage booking form submits correctly
✅ OTP sends and verifies
✅ Fare calculator computes correctly
✅ Payment gateway processes test payments
✅ Booking confirmation SMS/WhatsApp/email delivered
✅ Admin panel login and booking management
✅ Driver panel trip acceptance flow
✅ Customer dashboard shows booking history

DEVICE TESTING
✅ iPhone (Safari)
✅ Android Chrome
✅ Desktop Chrome
✅ Desktop Firefox
✅ Desktop Safari
✅ iPad/Tablet

SPEED TESTING
✅ Google PageSpeed Insights: 90+ mobile & desktop
✅ GTmetrix Grade A
✅ Pingdom < 2 seconds load time
✅ Core Web Vitals pass in Search Console
```

---

## 📞 Support & Contact

**Technical Support:**  
+91-93557 57579  
onewaybharatcab@gmail.com

**Office Address:**  
Shop No. 7, Radha Kunj 2,  
Ghaziabad, Uttar Pradesh – 203207, India

**Website:** [one-waybharat.com](https://one-waybharat.com)

---

*© 2024 One-Way Bhaarat Private Limited. All Rights Reserved.*  
*Proudly Made in India 🇮🇳*
