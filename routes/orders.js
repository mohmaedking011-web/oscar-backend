import express from "express";
import admin from "firebase-admin";

const router = express.Router();

// 1️⃣ معالجة المهمة اليومية وقبولها تلقائياً بعد 3 ثوانٍ
const processDailyTask = async (req, res) => {
    try {
        const db = admin.firestore();
        const { userId, planType, taskId } = req.body;

        // 1. خريطة أسعار الاشتراكات
        const rewardsMap = {
            S1: 2,
            S2: 4,
            O1: 15,
            O2: 30,
            A1: 60
        };

        // 2. جلب بيانات المستخدم من الفايربيس
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
        }

        const userData = userDoc.data();

        // 3. تحديد نوع الاشتراك وتحديد المكافأة
        const userSub = planType || userData.subscription || userData.plan;
        const reward = rewardsMap[userSub] || 0;

        // 4. حساب الرصيد الجديد
        const newBalance = (userData.balance || 0) + reward;

        // 5. تحديث الفايربيس
        await userRef.update({
            balance: newBalance,
            dailyReward: reward
        });

        return res.json({ success: true, reward, newBalance });

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

router.post("/task/claim", processDailyTask);
router.post("/create", processDailyTask);
router.post("/accomplishment/submit", processDailyTask);

// 2️⃣ طلب السحب
router.post("/withdraw/request", async (req, res) => {
  try {
    const db = admin.firestore();
    const { userId, amount } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "مبلغ السحب غير صالح" });
    }

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    }

    const currentBalance = userDoc.data().taskBalance || 0;
    if (currentBalance < amount) {
      return res.status(400).json({ success: false, message: "رصيد المهام غير كافٍ" });
    }

    const pendingWithdraws = await db.collection("withdrawals")
      .where("userId", "==", userId)
      .where("status", "==", "pending")
      .get();

    if (!pendingWithdraws.empty) {
      return res.status(400).json({
        success: false,
        message: "لديك طلب سحب قيد الانتظار بالفعل، لا يمكنك إرسال طلب جديد حتى يتم إكمال الطلب المسبق."
      });
    }

    await db.collection("users").doc(userId).update({
      taskBalance: admin.firestore.FieldValue.increment(-amount)
    });

    const withdrawRef = await db.collection("withdrawals").add({
      userId,
      amount,
      status: "pending",
      requestedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json({
      success: true,
      withdrawId: withdrawRef.id,
      message: "تم إرسال طلب السحب للإدارة وخصم المبلغ من رصيدك فوراً."
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 3️⃣ الإعدادات
router.get("/user/settings/:userId", async (req, res) => {
  try {
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.params.userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    }

    const userData = userDoc.data();
    const subscriptionDate = userData.subscriptionDate ? userData.subscriptionDate.toDate() : new Date();

    const now = new Date();
    const diffTime = Math.abs(now - subscriptionDate);
    const daysPassed = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const totalWorkingDays = 365;
    const remainingDays = Math.max(0, totalWorkingDays - daysPassed);

    res.json({
      success: true,
      data: {
        subscriptionDate: subscriptionDate.toISOString().split("T")[0],
        totalWorkingDays,
        daysPassed,
        remainingDays
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 4️⃣ البروفايل وشرط القائد والرواتب
router.get("/user/profile/:userId", async (req, res) => {
  try {
    const db = admin.firestore();
    const { userId } = req.params;

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    }

    const userData = userDoc.data();

    const directReferrals = await db.collection("users")
      .where("referredBy", "==", userId)
      .where("planType", "in", ["O1", "O2", "A1"])
      .get();

    const eligibleCount = directReferrals.size;
    const isLeader = eligibleCount >= 3;

    let leaderLevel = userData.leaderLevel || (isLeader ? 1 : 0);
    let leaderSalary = 0;

    if (isLeader) {
      if (leaderLevel === 1) leaderSalary = 20;
      else if (leaderLevel === 2) leaderSalary = 45;
      else if (leaderLevel === 3) leaderSalary = 100;
      else if (leaderLevel === 4) leaderSalary = 230;
    }

    res.json({
      success: true,
      data: {
        username: userData.username || "",
        email: userData.email || "",
        isLeader: isLeader ? "قائد" : "عضو",
        leaderLevel: isLeader ? "المستوى " + leaderLevel : "غير متاح",
        leaderSalary: isLeader ? "$" + leaderSalary : "$0",
        eligibleDirectReferrals: eligibleCount
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;