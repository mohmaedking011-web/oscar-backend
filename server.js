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

// نسب مكافآت الإحالة للمستويات الـ 5
const REFERRAL_PERCENTAGES = [0.12, 0.06, 0.04, 0.02, 0.02]; // L1 to L5

/**
 * دالة توزيع مكافآت الإحالة على 5 مستويات وتسجيلها في السجل
 */
async function distributeReferralBonuses(depositorUserId, depositAmount) {
  try {
    let currentUserId = depositorUserId;

    for (let level = 1; level <= 5; level++) {
      const userDoc = await db.collection("users").doc(currentUserId).get();
      if (!userDoc.exists) break;

      const userData = userDoc.data();
      const referrerId = userData.invitedBy || userData.referrerId; // معرف الداعي/المُحيل

      if (!referrerId) break; // توقف إذا لم يكن هناك داعي أعلا منه

      const bonusPercent = REFERRAL_PERCENTAGES[level - 1];
      const bonusAmount = depositAmount * bonusPercent;

      if (bonusAmount > 0) {
        // 1. زيادة رصيد القائد ومكافأة الإحالة الداخلية
        await db.collection("users").doc(referrerId).update({
          balance: admin.firestore.FieldValue.increment(bonusAmount),
          referralReward: admin.firestore.FieldValue.increment(bonusAmount)
        });

        // 2. تسجيل عملية الإحالة في سجل التوظيف/الإحالات مع الوقت والتاريخ
        await db.collection("referrals").add({
          userId: referrerId,             // المستفيد من المكافأة
          fromUserId: depositorUserId,    // الموظف الذي قام بالإيداع
          level: `L${level}`,            // مستوى الإحالة L1..L5
          depositAmount: depositAmount,
          bonusAmount: bonusAmount,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`🎁 [Referral L${level}] Credited ${bonusAmount} USDT to referrer ${referrerId}`);
      }

      // الانتقال للمستوى الأعلى في الشجرة
      currentUserId = referrerId;
    }
  } catch (err) {
    console.error("❌ Error distributing referral bonuses:", err);
  }
}

/**
 * دالة احتساب موعد الوصول المتوقع خلال 72 ساعة عمل (تخطي السبت والأحد)
 */
function calculateBusinessArrivalDate(startDate, businessHoursToAdd = 72) {
  let currentDate = new Date(startDate);
  let hoursRemaining = businessHoursToAdd;

  while (hoursRemaining > 0) {
    currentDate.setHours(currentDate.getHours() + 1);
    const day = currentDate.getDay();
    if (day !== 0 && day !== 6) {
      hoursRemaining--;
    }
  }
  return currentDate;
}

/**
 * دالة تحديد نسبة الخصم حسب رتبة المستخدم
 */
function getFeePercentage(userData) {
  if (userData.withdrawFee !== undefined) {
    return parseFloat(userData.withdrawFee);
  }
  const level = Number(userData.LeaderLevel) || 0;
  switch (level) {
    case 1: return 19;
    case 2: return 17;
    case 3: return 15;
    case 4: return 11;
    default: return 21;
  }
}

async function fundGasAndSweep(tempPrivateKey, tempAddress, amountUSDT) {
  const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;
  if (!ADMIN_WALLET || !tempPrivateKey) {
    console.log("⚠️ تم تخطي الـ Sweep: البيانات غير متوفرة.");
    return;
  }

  try {
    console.log(`⛽ [Gas Fee] إرسال 20 TRX إلى المحفظة الفرعية: ${tempAddress}...`);
    const trxAmountInSun = tronWeb.toSun(20);
    const gasTx = await tronWeb.trx.sendTransaction(tempAddress, trxAmountInSun);
    console.log(`✅ [Gas Fee] تم إرسال TRX بنجاح. TxID: ${gasTx.result ? gasTx.transaction.txID : gasTx.txid}`);

    await new Promise(resolve => setTimeout(resolve, 20000));

    const tempTronWeb = new TronWeb({
      fullHost: "https://api.trongrid.io",
      headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" },
      privateKey: tempPrivateKey
    });

    const amountInSun = BigInt(Math.floor(amountUSDT * 1e6)).toString();
    const parameter = [
      { type: 'address', value: ADMIN_WALLET },
      { type: 'uint256', value: amountInSun }
    ];

    let attempts = 0;
    let sweepSuccess = false;

    while (attempts < 4) {
      try {
        attempts++;
        console.log(`🚀 محاولة السحب الآلي رقم (${attempts})...`);
        const options = { feeLimit: 100000000 };
        const transaction = await tempTronWeb.transactionBuilder.triggerSmartContract(
          USDT_CONTRACT_ADDRESS,
          'transfer(address,uint256)',
          options,
          parameter,
          tempAddress
        );

        const signedTx = await tempTronWeb.trx.sign(transaction.transaction);
        const broadcast = await tempTronWeb.trx.sendRawTransaction(signedTx);

        if (broadcast && broadcast.result) {
          console.log(`🎉 [Sweep Success] تم تحويل ${amountUSDT} USDT بنجاح إلى المحفظة الرئيسية! TXID: ${broadcast.txid}`);
          sweepSuccess = true;
          break;
        }
      } catch (retryErr) {
        const delayTime = attempts * 7000;
        console.log(`⚠️ محاولة السحب رقم ${attempts} فشلت [${retryErr.message || retryErr}]، انتظار ${delayTime / 1000} ثوانٍ...`);
        await new Promise(resolve => setTimeout(resolve, delayTime));
      }
    }

    if (!sweepSuccess) {
      console.error("❌ فشلت محاولات السحب الآلي بعد عدة محاولات متكررة.");
    }
  } catch (err) {
    console.error("⚠️ [Sweep Error] خطأ أثناء عملية السحب الآلي:", err.message || err);
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

app.get("/ping", (req, res) => {
  res.send("pong");
});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Oscar Backend Service is Running Live!"
  });
});

// 📌 مسار توليد/جلب المحفظة الثابتة
app.post("/api/generate-wallet", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (userDoc.exists && userDoc.data().depositAddress) {
      return res.json({
        success: true,
        address: userDoc.data().depositAddress
      });
    }

    const account = await TronWeb.createAccount();

    await userRef.set({
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

// 📌 مسار الفحص المباشر للإيداع
app.post("/api/check-deposit", async (req, res) => {
  try {
    const { userId, address } = req.body;
    if (!userId || !address) {
      checkDeposits().catch(err => console.error("Background check error:", err));
      return res.json({ success: true, message: "Global deposit check triggered in background" });
    }

    const response = await fetch(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?contract_address=${USDT_CONTRACT_ADDRESS}`,
      { headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" } }
    );

    if (!response.ok) {
      return res.json({ success: true, deposited: false, message: "TronGrid rate limited" });
    }

    const data = await response.json();

    if (data.data && data.data.length > 0) {
      for (const tx of data.data) {
        if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
          const txDoc = await db.collection("processed_txs").doc(tx.transaction_id).get();

          if (!txDoc.exists) {
            const amountReceived = parseFloat(tx.value) / 1e6;

            // 1. زيادة رصيد الموظف المُودِع
            await db.collection("users").doc(userId).update({
              balance: admin.firestore.FieldValue.increment(amountReceived)
            });

            // 2. تسجيل العملية لتجنب التكرار
            await db.collection("processed_txs").doc(tx.transaction_id).set({
              userId: userId,
              amount: amountReceived,
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // 3. إضافة سجل الإيداع
            await db.collection("deposits").add({
              userId: userId,
              amount: amountReceived,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              status: "completed",
              txid: tx.transaction_id
            });

            // 4. توزيع مكافآت الإحالة (12%, 6%, 4%, 2%, 2%) على الداعين
            await distributeReferralBonuses(userId, amountReceived);

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

// 📌 مسار تقديم طلب السحب وتخزينه في مجموعة withdrawals
app.post("/api/request-withdrawal", async (req, res) => {
  try {
    const { userId, amount, walletAddress, network = "TRC20" } = req.body;

    if (!userId || !amount || !walletAddress) {
      return res.status(400).json({ success: false, error: "userId, amount, and walletAddress are required" });
    }

    const withdrawAmount = parseFloat(amount);
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(400).json({ success: false, error: "Invalid withdrawal amount" });
    }

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const userData = userDoc.data();
    const currentBalance = parseFloat(userData.balance || 0);

    if (currentBalance < withdrawAmount) {
      return res.status(400).json({ success: false, error: "Insufficient balance" });
    }

    const feePercentage = getFeePercentage(userData);
    const feeAmount = (withdrawAmount * feePercentage) / 100;
    const netAmount = withdrawAmount - feeAmount;

    const now = new Date();
    const arrivalDate = calculateBusinessArrivalDate(now, 72);

    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-withdrawAmount)
    });

    const withdrawalDocRef = await db.collection("withdrawals").add({
      userId: userId,
      amount: withdrawAmount,
      feePercentage: feePercentage,
      feeAmount: feeAmount,
      netAmount: netAmount,
      walletAddress: walletAddress,
      network: network,
      status: "pending",
      createdAt: admin.firestore.Timestamp.fromDate(now),
      expectedArrivalDate: admin.firestore.Timestamp.fromDate(arrivalDate)
    });

    return res.json({
      success: true,
      message: "Withdrawal request submitted successfully",
      withdrawalId: withdrawalDocRef.id,
      amount: withdrawAmount,
      feePercentage: feePercentage,
      feeAmount: feeAmount,
      netAmount: netAmount,
      expectedArrivalDate: arrivalDate
    });

  } catch (error) {
    console.error("Error creating withdrawal request:", error);
    res.status(500).json({ success: false, error: error.message });
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
        { headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" } }
      );

      if (!response.ok) continue;
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

              await db.collection("deposits").add({
                userId: doc.id,
                amount: amountReceived,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                status: "completed",
                txid: tx.transaction_id
              });

              // توزيع المكافآت للمستويات الـ 5
              await distributeReferralBonuses(doc.id, amountReceived);

              console.log(`✅ Successfully credited ${amountReceived} USDT to user ${doc.id}`);

              if (userData.depositPrivateKey) {
                fundGasAndSweep(userData.depositPrivateKey, userData.depositAddress, amountReceived);
              }
            }
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch (err) {
    console.error("Error checking deposits:", err);
  }
}

setInterval(checkDeposits, 180000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Oscar Backend running on port ${PORT} (0.0.0.0)`);
});