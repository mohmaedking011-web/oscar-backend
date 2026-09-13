import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TronWeb } from "tronweb";
import dotenv from "dotenv";

dotenv.config();

import ordersRouter from "./routes/orders.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 1. إعداد Firebase Admin
const serviceAccountPath = join(__dirname, "serviceAccountKey.json");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// 2. إعداد TronWeb باستهلاك المفتاح الخاص من البيئة
const tronWeb = new TronWeb({
  fullHost: "https://api.trongrid.io",
  headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
  privateKey: process.env.ADMIN_PRIVATE_KEY || undefined
});

const USDT_CONTRACT_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // عقد USDT TRC20 الرسمي

const app = express();

// إعداد CORS بالكامل
app.use(cors({
  origin: true, // السماح لجميع المصادر مع التعامل مع Preflight
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

app.options("*", cors());

app.use(express.json());

app.use("/routes/orders", ordersRouter);

// مسار الاختبار الرئيسي
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Oscar Backend is running successfully"
  });
});

// 3. مسار توليد محفظة فرعية لكل مستخدم (الإيداع التلقائي)
app.post("/api/generate-wallet", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    // إنشاء محفظة جديدة توافق TronWeb v6
    const account = await tronWeb.createRandom();

    await db.collection("users").doc(userId).set({
      depositAddress: account.address,
      depositPrivateKey: account.privateKey
    }, { merge: true });

    res.json({
      success: true,
      address: account.address
    });
  } catch (error) {
    console.error("Error generating wallet:", error);
    res.status(500).json({ error: error.message });
  }
});

// 4. مسار السحب التلقائي (الأدمن يدفع للمستخدم)
app.post("/api/withdraw-auto", async (req, res) => {
  try {
    const { toAddress, amount } = req.body;
    if (!toAddress || !amount) {
      return res.status(400).json({ error: "Address and amount are required" });
    }

    const contract = await tronWeb.contract().at(USDT_CONTRACT_ADDRESS);
    const amountInSun = BigInt(Math.floor(amount * 1e6)).toString();

    const transaction = await contract.transfer(toAddress, amountInSun).send();

    res.json({
      success: true,
      txid: transaction
    });
  } catch (error) {
    console.error("Automated withdrawal error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 5. وظيفة مراقبة الإيداعات والتجميع التلقائي (Auto-Sweep Cron Job)
async function checkDeposits() {
  try {
    const usersSnapshot = await db.collection("users").get();
    const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS; // عنوان محفظتك المركزية لتجميع الأموال

    for (const doc of usersSnapshot.docs) {
      const userData = doc.data();
      if (!userData.depositAddress) continue;

      const response = await fetch(
        `https://api.trongrid.io/v1/accounts/${userData.depositAddress}/transactions/trc20?contract_address=${USDT_CONTRACT_ADDRESS}`,
        {
          headers: {
            "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || ""
          }
        }
      );
      const data = await response.json();

      if (data.data && data.data.length > 0) {
        for (const tx of data.data) {
          // مقارنة العناوين بغض النظر عن حالة الحروف
          if (tx.to && tx.to.toLowerCase() === userData.depositAddress.toLowerCase()) {
            const txDoc = await db.collection("processed_txs").doc(tx.transaction_id).get();

            if (!txDoc.exists) {
              const amountReceived = parseFloat(tx.value) / 1e6;

              // 1. تحديث رصيد المستخدم في قاعدة البيانات
              await db.collection("users").doc(doc.id).update({
                balance: admin.firestore.FieldValue.increment(amountReceived)
              });

              // 2. تسجيل المعاملة لتفادي التكرار
              await db.collection("processed_txs").doc(tx.transaction_id).set({
                userId: doc.id,
                amount: amountReceived,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
              });

              console.log(`✅ Successfully credited ${amountReceived} USDT to user ${doc.id}`);

              // 3. تحويل الأموال تلقائياً من محفظة المستخدم إلى المحفظة المركزية (Auto-Sweep)
              if (ADMIN_WALLET && userData.depositPrivateKey) {
                try {
                  const userTronWeb = new TronWeb({
                    fullHost: "https://api.trongrid.io",
                    headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
                    privateKey: userData.depositPrivateKey
                  });

                  const contract = await userTronWeb.contract().at(USDT_CONTRACT_ADDRESS);
                  const amountInSun = BigInt(Math.floor(amountReceived * 1e6)).toString();

                  const sweepTx = await contract.transfer(ADMIN_WALLET, amountInSun).send();
                  console.log(`🚀 Auto-swept ${amountReceived} USDT to Admin Wallet. TXID: ${sweepTx}`);
                } catch (sweepErr) {
                  console.error("⚠️ Auto-sweep error (Check TRX balance for gas fee):", sweepErr.message);
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Error checking deposits:", err);
  }
}

// تشغيل الفحص الدوري كل 60 ثانية
setInterval(checkDeposits, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Oscar Backend running on port ${PORT}`);
});