#!/bin/bash
echo "🔧 Setting up Zapchat Authentication Flow..."

# Step 1: Install dependencies
npm install passport passport-google-oauth20 nodemailer mongoose bcrypt jsonwebtoken express dotenv

# Step 2: Create .env file if not exists
if [ ! -f ".env" ]; then
  cat <<EOT >> .env
PORT=5000
MONGO_URI=your_mongodb_atlas_uri_here
JWT_SECRET=your_jwt_secret_here
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
EOT
  echo "✅ .env file created. Please update values for MongoDB and Google OAuth."
else
  echo "ℹ️ .env file already exists. Make sure MONGO_URI, JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET are set."
fi

# Step 3: Create routes folder if not exists
mkdir -p routes

# Step 4: Create authRoutes.js
cat <<'EOT' > routes/authRoutes.js
const express = require('express');
const passport = require('passport');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const router = express.Router();

// Example User model (replace with mongoose schema)
const users = [];

// Signup
router.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  users.push({ username, email, password: hashed });
  res.json({ message: 'User created successfully' });
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.email }, process.env.JWT_SECRET);
  res.json({ token });
});

// Forgot password
router.post('/forgot', async (req, res) => {
  const { email } = req.body;
  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const resetToken = jwt.sign({ id: user.email }, process.env.JWT_SECRET, { expiresIn: '15m' });
  // Send email with nodemailer
  res.json({ message: 'Reset link sent', resetToken });
});

module.exports = router;
EOT

# Step 5: Update index.js
cat <<'EOT' > index.js
const express = require('express');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const authRoutes = require('./routes/authRoutes');

dotenv.config();
const app = express();
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// Routes
app.use('/api/auth', authRoutes);

app.listen(process.env.PORT, () => {
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});
EOT

echo "🎉 Authentication flow setup complete!"
