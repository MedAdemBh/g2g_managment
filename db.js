import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  email: String,
  role: { type: String, required: true }, // 'seller' | 'supplier' | 'admin'
  g2gStoreName: { type: String, default: '' },
  commissionRate: { type: Number, default: 10 },
  balance: { type: Number, default: 0 },
  avatarColor: { type: String, default: '#00f0ff' }
});

const ItemSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  title: { type: String, required: true },
  game: { type: String, default: 'ARC Raiders' },
  category: { type: String, required: true },
  quantity: { type: Number, default: 1 },
  supplierId: { type: String, required: true },
  supplierName: String,
  supplierTargetPrice: { type: Number, default: 0 },
  g2gListingPrice: { type: Number, default: 0 },
  status: { type: String, default: 'available' }, // 'available' | 'locked_by_seller' | 'sold'
  lockedBySellerId: { type: String, default: null },
  lockedBySellerName: { type: String, default: null },
  lockedAt: { type: String, default: null },
  g2gListingId: { type: String, default: '' },
  g2gOrderId: { type: String, default: '' },
  soldPrice: { type: Number, default: null },
  soldAt: { type: String, default: null },
  secretCredentials: { type: String, default: '' },
  notes: { type: String, default: '' },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

const WithdrawalSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  userId: { type: String, required: true },
  userName: String,
  userRole: String,
  amount: { type: Number, required: true },
  fixedFee: { type: Number, default: 1.00 },
  percentFee: { type: Number, default: 0 },
  totalFee: { type: Number, default: 1.00 },
  netPayout: { type: Number, required: true },
  method: { type: String, default: 'G2G Wallet / Bank' },
  destination: { type: String, default: '' },
  status: { type: String, default: 'completed' },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

const ActivityLogSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  timestamp: { type: String, default: () => new Date().toISOString() },
  type: { type: String, required: true },
  actorName: String,
  message: { type: String, required: true }
});

export const User = mongoose.models.User || mongoose.model('User', UserSchema);
export const Item = mongoose.models.Item || mongoose.model('Item', ItemSchema);
export const Withdrawal = mongoose.models.Withdrawal || mongoose.model('Withdrawal', WithdrawalSchema);
export const ActivityLog = mongoose.models.ActivityLog || mongoose.model('ActivityLog', ActivityLogSchema);

// Cached connection for Vercel Serverless
let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return null; // Signals fallback to local JSON file
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false
    };
    cached.promise = mongoose.connect(uri, opts).then((m) => m);
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    console.error('MongoDB connection error:', e);
    throw e;
  }

  return cached.conn;
}

// Initial seed helper if MongoDB is fresh
export async function seedInitialUsersIfEmpty(defaultUsers) {
  try {
    const count = await User.countDocuments();
    if (count === 0 && defaultUsers && defaultUsers.length > 0) {
      await User.insertMany(defaultUsers);
      console.log('Seeded initial users into MongoDB Atlas.');
    }
  } catch (err) {
    console.error('Error seeding initial users into MongoDB:', err);
  }
}
