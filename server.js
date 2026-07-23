import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// استيراد مسار الطلبات بشكل صحيح
import ordersRouter from "./routes/orders.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serviceAccountPath = join(__dirname, "serviceAccountKey.json");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));

const app = express();
app.use(cors());
app.use(express.json());

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

// الرئيسية
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Oscar Backend is running successfully"
  });
});

// ربط مسار الطلبات
app.use("/api/orders", ordersRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Oscar Backend running on port ${PORT}`);
});