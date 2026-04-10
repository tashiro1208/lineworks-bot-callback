const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();
app.use(express.json());

/**
 * 担当者マスタ
 * 左側 = メッセージに書く名前
 * 右側 = LINE WORKSの実ユーザーID
 *
 * ※ ここは後で本物のユーザーIDに置き換える
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

const processedEvents = new Set();

app.get("/", (req, res) => {
  res.send("Bot server is running");
});

/**
 * OAuth認可コード受け取り用
 */
app.get("/oauth/callback", (req, res) => {
  const code = req.query.code || "";
  const state = req.query.state || "";
  const error = req.query.error || "";
  const errorDescription = req.query.error_description || "";

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>LINE WORKS OAuth Callback</title>
      </head>
      <body style="font-family: sans-serif; padding: 24px;">
        <h2>OAuth Callback Result</h2>
        <p><strong>code</strong></p>
        <pre>${escapeHtml(code)}</pre>
        <p><strong>state</strong></p>
        <pre>${escapeHtml(state)}</pre>
        <p><strong>error</strong></p>
        <pre>${escapeHtml(error)}</pre>
        <p><strong>error_description</strong></p>
        <pre>${escapeHtml(errorDescription)}</pre>
      </body>
    </html>
  `);
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 例:
 * 田代健へ
 * 4月21日までに請求書発行をお願いします
 */
function parseTaskText(text) {
  if (!text) return null;

  const lines = text
    .split("\n")
    .map(v => v.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  const assigneeLine = lines[0];
  const assigneeMatch = assigneeLine.match(/^(.+?)へ$/);
  if (!assigneeMatch) return null;

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
 * Refresh Token から Access Token を取得
 */
async function getAccessToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("client_id", process.env.LW_CLIENT_ID);
  params.append("client_secret", process.env.LW_CLIENT_SECRET);
  params.append("refresh_token", process.env.LW_REFRESH_TOKEN);

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
 * LINE WORKS タスク作成
 * 実行先:
 * https://www.worksapis.com/v1.0/users/{userId}/tasks
 */
async function createTask({ assigneeUserId, title, dueDate, note }) {
  const accessToken = await getAccessToken();

  const requestBody = {
    title: title || "未設定",
    due: dueDate ? `${dueDate}T09:00:00+09:00` : undefined,
    memo: note
  };

  const response = await axios.post(
    `https://www.worksapis.com/v1.0/users/${assigneeUserId}/tasks`,
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

async function notifyResult(message) {
  console.log("通知:", message);
}

app.post("/callback", async (req, res) => {
  try {
    console.log("受信データ:", JSON.stringify(req.body, null, 2));

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

    if (
      !process.env.LW_REFRESH_TOKEN ||
      process.env.LW_REFRESH_TOKEN === "TEMP"
    ) {
      console.log("Refresh Token 未設定のため、タスク作成は未実行");
      await notifyResult(
        `解析成功: ${assignee.displayName} / ${parsed.title} / due=${parsed.dueDate || "なし"}`
      );
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
