const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

/**
 * 担当者マスタ
 * 左側 = メッセージで書く名前
 * userId = LINE WORKSの実ユーザーID
 *
 * ここだけ後で本物に置き換える
 */
const ASSIGNEE_MASTER = {
  "フジ子さんチーム": {
    userId: "USER_ID_FUJIKO_TEAM",
    displayName: "フジ子さんチーム"
  },
  "田代健": {
    userId: "USER_ID_KEN_TASHIRO",
    displayName: "田代健"
  },
  "坂下めぐみ": {
    userId: "USER_ID_MEGUMI_SAKASHITA",
    displayName: "坂下めぐみ"
  }
};

/**
 * 簡易的な重複防止
 */
const processedEvents = new Set();

/**
 * 動作確認用
 */
app.get("/", (req, res) => {
  res.send("Bot server is running");
});

/**
 * 文章例
 * フジ子さんチームへ
 * 4月21日までに請求書発行をお願いします
 */
function parseTaskText(text) {
  if (!text) return null;

  const lines = text
    .split("\n")
    .map(v => v.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const assigneeLine = lines[0];
  const assigneeMatch = assigneeLine.match(/^(.+?)へ$/);

  if (!assigneeMatch) {
    return null;
  }

  const assigneeName = assigneeMatch[1].trim();
  const restText = lines.slice(1).join(" ").trim();

  let dueDate = null;
  let title = restText;

  const deadlineMatch = restText.match(/(\d{1,2})月(\d{1,2})日までに/);

  if (deadlineMatch) {
    const month = Number(deadlineMatch[1]);
    const day = Number(deadlineMatch[2]);

    const now = new Date();
    let year = now.getFullYear();

    const tentative = new Date(year, month - 1, day);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (tentative < today) {
      year += 1;
    }

    dueDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    title = restText.replace(/^\d{1,2}月\d{1,2}日までに/, "").trim();
  }

  return {
    assigneeName,
    title,
    dueDate,
    originalText: text
  };
}

/**
 * LINE WORKSのアクセストークン取得
 */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: process.env.LW_CLIENT_ID,
    sub: process.env.LW_SERVICE_ACCOUNT,
    iat: now,
    exp: now + 300
  };

  const signedJwt = jwt.sign(
    payload,
    process.env.LW_PRIVATE_KEY.replace(/\\n/g, "\n"),
    { algorithm: "RS256" }
  );

  const params = new URLSearchParams();
  params.append("assertion", signedJwt);
  params.append("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  params.append("client_id", process.env.LW_CLIENT_ID);
  params.append("client_secret", process.env.LW_CLIENT_SECRET);
  params.append("scope", process.env.LW_SCOPE || "task");

  const response = await axios.post(
    process.env.LW_TOKEN_URL,
    params,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return response.data.access_token;
}

/**
 * タスク作成
 * URLとbody項目名は、あなたのLINE WORKS API設定に合わせて最終調整が必要
 */
async function createTask({ assigneeUserId, title, dueDate, note }) {
  const accessToken = await getAccessToken();

  const requestBody = {
    title: title || "未設定",
    assigneeId: assigneeUserId,
    dueDate: dueDate,
    note: note
  };

  const response = await axios.post(
    process.env.LW_TASK_CREATE_URL,
    requestBody,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data;
}

/**
 * 結果通知
 * 今はログだけ
 */
async function notifyResult(message) {
  console.log("通知:", message);
}

/**
 * Callback受信
 */
app.post("/callback", async (req, res) => {
  try {
    console.log("受信データ:", JSON.stringify(req.body, null, 2));

    // LINE WORKSには先に200を返す
    res.status(200).send("OK");

    const eventId =
      req.body?.content?.eventId ||
      req.body?.eventId ||
      crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");

    if (processedEvents.has(eventId)) {
      console.log("重複イベントのためスキップ:", eventId);
      return;
    }
    processedEvents.add(eventId);

    const text =
      req.body?.content?.text ||
      req.body?.text ||
      "";

    if (!text) {
      console.log("テキストなしのため終了");
      return;
    }

    const parsed = parseTaskText(text);

    if (!parsed) {
      console.log("タスク形式ではないため終了");
      return;
    }

    const assignee = ASSIGNEE_MASTER[parsed.assigneeName];

    if (!assignee) {
      console.log("担当者マスタ未登録:", parsed.assigneeName);
      await notifyResult(`担当者マスタ未登録: ${parsed.assigneeName}`);
      return;
    }

    const result = await createTask({
      assigneeUserId: assignee.userId,
      title: parsed.title,
      dueDate: parsed.dueDate,
      note: parsed.originalText
    });

    console.log("タスク作成成功:", JSON.stringify(result, null, 2));
    await notifyResult(`タスク作成成功: ${assignee.displayName} / ${parsed.title}`);
  } catch (error) {
    console.error("処理エラー:", error.response?.data || error.message || error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
