const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(express.json());

const ASSIGNEE_MASTER = {
  "フジ子さんチーム": {
    userId: "USER_ID_FUJIKO_TEAM",
    displayName: "フジ子さんチーム"
  },
  "田代健": {
    userId: "50bde2c2-34b1-401e-10db-05079b77bc42",
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

app.get("/test-task", async (req, res) => {
  try {
    const result = await createTask({
      assigneeUserId: "50bde2c2-34b1-401e-10db-05079b77bc42",
      title: "テストタスク",
      content: "テスト内容",
      dueDate: "2026-04-21"
    });

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || String(error)
    });
  }
});

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
  let content = restText;

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
    content = restText.replace(/^\d{1,2}月\d{1,2}日までに/, "").trim();
  }

  return {
    assigneeName,
    title: content,
    content,
    dueDate,
    originalText: text
  };
}

async function getAccessToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("client_id", process.env.LW_CLIENT_ID);
  params.append("client_secret", process.env.LW_CLIENT_SECRET);
  params.append("refresh_token", process.env.LW_REFRESH_TOKEN);

  const response = await axios.post(process.env.LW_TOKEN_URL, params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  console.log("トークン取得レスポンス:", JSON.stringify(response.data, null, 2));

  if (!response.data || !response.data.access_token) {
    throw new Error(`access_token取得失敗: ${JSON.stringify(response.data)}`);
  }

  return response.data.access_token;
}

async function createTask({ assigneeUserId, title, content, dueDate }) {
  const accessToken = await getAccessToken();

    const requestBody = {
    assignorId: assigneeUserId,
    assignees: [
      {
        assigneeId: assigneeUserId,
        status: "TODO"
      }
    ],
    title: title || "未設定",
    content: content || title || "未設定",
    dueDate: dueDate || undefined,
    completionCondition: "ANY_ONE"
  };

  const jsonBody = JSON.stringify(requestBody);
  console.log("タスク作成リクエスト:", jsonBody);

  const options = {
    hostname: "www.worksapis.com",
    path: `/v1.0/users/${assigneeUserId}/tasks`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(jsonBody, "utf8")
    }
  };

  const responseText = await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        console.log("タスク作成レスポンス:", res.statusCode, data);

        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(data));
        }
      });
    });

    req.on("error", reject);
    req.write(jsonBody);
    req.end();
  });

  return JSON.parse(responseText);
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

    const result = await createTask({
      assigneeUserId: assignee.userId,
      title: parsed.title,
      content: parsed.content,
      dueDate: parsed.dueDate
    });

    console.log("タスク作成成功:", JSON.stringify(result, null, 2));
    await notifyResult(`タスク作成成功: ${assignee.displayName} / ${parsed.title}`);
  } catch (error) {
    console.error("処理エラー:", error.message || error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
