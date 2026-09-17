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

// 2. إعداد TronWeb Admin
const tronWeb = new TronWeb({
  fullHost: "https://api.trongrid.io",
  headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
  privateKey: process.env.ADMIN_PRIVATE_KEY || undefined
});

const USDT_CONTRACT_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

async function fundGasAndSweep(tempPrivateKey, tempAddress, amountUSDT) {
  const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;
  if (!ADMIN_WALLET || !tempPrivateKey) {
    console.log("⚠️ تم تخطي الـ Sweep: ADMIN_WALLET_ADDRESS أو depositPrivateKey غير متوفر.");
    return;
  }

  try {
    console.log(`⛽ [Gas Fee] إرسال 20 TRX إلى المحفظة الفرعية: ${tempAddress}...`);
    
    const trxAmountInSun = tronWeb.toSun(20);
    const gasTx = await tronWeb.trx.sendTransaction(tempAddress, trxAmountInSun);
    console.log(`✅ [Gas Fee] تم إرسال TRX بنجاح. TxID: ${gasTx.result ? gasTx.transaction.txID : gasTx.txid}`);

    await new Promise(resolve => setTimeout(resolve, 8000));

    const tempTronWeb = new TronWeb({
      fullHost: "https://api.trongrid.io",
      headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
      privateKey: tempPrivateKey
    });

    const contract = await tempTronWeb.contract().at(USDT_CONTRACT_ADDRESS);
    const amountInSun = BigInt(Math.floor(amountUSDT * 1e6)).toString();

    const sweepTx = await contract.transfer(ADMIN_WALLET, amountInSun).send();
    console.log(`🚀 [Sweep Success] تم تحويل ${amountUSDT} USDT بنجاح إلى TronLink! TXID: ${sweepTx}`);
  } catch (err) {
    console.error("⚠️ [Sweep Error] خطأ أثناء عملية السحب الآلي:", err.message);
  }
}

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

app.use(express.json());

app.use("/routes/orders", ordersRouter);

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Oscar Backend Service is Running Live!"
  });
});

app.post("/api/generate-wallet", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const account = await TronWeb.createAccount();

    await db.collection("users").doc(userId).set({
      depositAddress: account.address.base58,
      depositPrivateKey: account.privateKey
    }, { merge: true });

    res.json({
      success: true,
      address: account.address.base58
    });
  } catch (error) {
    console.error("Error generating wallet:", error);
    res.status(500).json({ error: error.message });
  }
});

// مسار التوليد السريع بالخلفية (يمنع الـ Timeout تماماً)
app.get("/api/generate-wallets-for-all", (req, res) => {
  res.json({
    success: true,
    message: "Background wallet generation started for all users without wallets. Check logs or Firestore in 1 minute."
  });

  (async () => {
    try {
      console.log("🔄 Starting async wallet generation...");
      const usersSnapshot = await db.collection("users").get();
      let count = 0;

      for (const doc of usersSnapshot.docs) {
        const userData = doc.data();
        if (!userData.depositAddress || !userData.depositPrivateKey) {
          const account = await TronWeb.createAccount();
          
          await db.collection("users").doc(doc.id).set({
            depositAddress: account.address.base58,
            depositPrivateKey: account.privateKey
          }, { merge: true });

          count++;
        }
      }
      console.log(`✅ Async generation finished: Generated wallets for ${count} users.`);
    } catch (error) {
      console.error("❌ Error during async wallet generation:", error);
    }
  })();
});

app.get("/api/check-deposit", async (req, res) => {
  try {
    await checkDeposits();
    res.json({ success: true, message: "Manual global deposit check triggered successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/check-deposit", async (req, res) => {
  try {
    const { userId, address } = req.body;
    if (!userId || !address) {
      await checkDeposits();
      return res.json({ success: true, message: "Global deposit check triggered" });
    }

    const response = await fetch(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?contract_address=${USDT_CONTRACT_ADDRESS}`,
      {
        headers: {
          "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || ""
        }
      }
    );
    const data = await response.json();

    if (data.data && data.data.length > 0) {
      for (const tx of data.data) {
        if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
          const txDoc = await db.collection("processed_txs").doc(tx.transaction_id).get();

          if (!txDoc.exists) {
            const amountReceived = parseFloat(tx.value) / 1e6;

            await db.collection("users").doc(userId).update({
              balance: admin.firestore.FieldValue.increment(amountReceived)
            });

            await db.collection("processed_txs").doc(tx.transaction_id).set({
              userId: userId,
              amount: amountReceived,
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`✅ Instant Auto-Deposit: Credited ${amountReceived} USDT to user ${userId}`);

            const userDoc = await db.collection("users").doc(userId).get();
            const userData = userDoc.data();
            if (userData && userData.depositPrivateKey) {
              fundGasAndSweep(userData.depositPrivateKey, address, amountReceived);
            }

            return res.json({
              success: true,
              deposited: true,
              amount: amountReceived
            });
          }
        }
      }
    }

    return res.json({ success: true, deposited: false });
  } catch (error) {
    console.error("Check deposit endpoint error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

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

async function checkDeposits() {
  console.log("⏰ [Cron] Starting scheduled deposit check across all user wallets...");
  try {
    const usersSnapshot = await db.collection("users").get();

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
          if (tx.to && tx.to.toLowerCase() === userData.depositAddress.toLowerCase()) {
            const txDoc = await db.collection("processed_txs").doc(tx.transaction_id).get();

            if (!txDoc.exists) {
              const amountReceived = parseFloat(tx.value) / 1e6;

              await db.collection("users").doc(doc.id).update({
                balance: admin.firestore.FieldValue.increment(amountReceived)
              });

              await db.collection("processed_txs").doc(tx.transaction_id).set({
                userId: doc.id,
                amount: amountReceived,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
              });

              console.log(`✅ Successfully credited ${amountReceived} USDT to user ${doc.id}`);

              if (userData.depositPrivateKey) {
                fundGasAndSweep(userData.depositPrivateKey, userData.depositAddress, amountReceived);
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

// الفحص الدوري يتم كل 3 دقائق دون حظر إقلاع السيرفر
setInterval(checkDeposits, 180000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Oscar Backend running on port ${PORT} (0.0.0.0)`);
});