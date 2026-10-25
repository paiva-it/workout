import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDb } from './db.js';

await connectDb();
const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, '0.0.0.0');
console.log(`workout api listening on :${port}`);
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    await app.close();
    await mongoose.disconnect();
    process.exit(0);
  });
}
