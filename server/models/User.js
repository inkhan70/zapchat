const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 32,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      default: null,
    },
    displayName: {
      type: String,
      trim: true,
      maxlength: 80,
      default: '',
    },
    avatar: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      default: 'Hey there! I am using ZapChat.',
      trim: true,
      maxlength: 160,
    },
    authProviders: {
      type: [String],
      default: ['password'],
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    resetPasswordTokenHash: {
      type: String,
      default: null,
    },
    resetPasswordExpiresAt: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1, username: 1 });
UserSchema.index({ resetPasswordTokenHash: 1, resetPasswordExpiresAt: 1 });

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
