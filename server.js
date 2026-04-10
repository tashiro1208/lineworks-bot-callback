const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(express.json());

/**
 * Bot専用ユーザーの userId
 * ここを本物に置き換える
 */
const BOT_ASSIGNOR_USER_ID = "BOT_USER_ID_HERE";

/**
 * 担当者マスタ
 * ここを本物に置き換える
 */
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

  if (!response.data || !response.data.access_token) {
    throw new Error(`access_token取得失敗: ${JSON.stringify(response.data)}`);
  }

  return response.data.access_token;
}

async function createTask({ assignorUserId, assigneeUserId, title, content, dueDate }) {
  const accessToken = await getAccessToken();

  const requestBody = {
    assignorId: assignorUserId,
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
    path: `/v1.0/users/${assignorUserId}/tasks`,
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

/**
 * トークルームへBot返信
 * roomId がある場合のみ返信
 */
async function sendRoomMessage({ roomId, text }) {
  if (!roomId) {
    console.log("roomId がないため返信スキップ");
    return;
  }

  const botId = process.env.LW_BOT_ID;
  const botToken = process.env.LW_BOT_TOKEN;

  if (!botId || !botToken) {
    console.log("LW_BOT_ID または LW_BOT_TOKEN 未設定のため返信スキップ");
    return;
  }

  const body = {
    content: {
      type: "text",
      text
    }
  };

  const response = await axios.post(
    `https://www.worksapis.com/v1.0/bots/${botId}/channels/${roomId}/messages`,
    body,
    {
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("Bot返信成功:", JSON.stringify(response.data, null, 2));
}

function buildSuccessMessage({ requesterName, assigneeName, dueDate, content }) {
  return [
    "タスクを登録しました。",
    requesterName ? `依頼者: ${requesterName}` : null,
    `担当: ${assigneeName}`,
    dueDate ? `期限: ${dueDate}` : "期限: 未設定",
    `内容: ${content}`
  ]
    .filter(Boolean)
    .join("\n");
}

function buildErrorMessage(message) {
  return `タスク登録に失敗しました。\n${message}`;
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

    const text = req.body?.content?.text || req.body?.text || "";
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

      await sendRoomMessage({
        roomId: req.body?.source?.roomId,
        text: buildErrorMessage(`担当者マスタ未登録: ${parsed.assigneeName}`)
      });
      return;
    }

    const result = await createTask({
      assignorUserId: BOT_ASSIGNOR_USER_ID,
      assigneeUserId: assignee.userId,
      title: parsed.title,
      content: parsed.content,
      dueDate: parsed.dueDate
    });

    console.log("タスク作成成功:", JSON.stringify(result, null, 2));

    await sendRoomMessage({
      roomId: req.body?.source?.roomId,
      text: buildSuccessMessage({
        requesterName: req.body?.source?.userName || "",
        assigneeName: assignee.displayName,
        dueDate: parsed.dueDate,
        content: parsed.content
      })
    });
  } catch (error) {
    console.error("処理エラー:", error.message || error);

    try {
      await sendRoomMessage({
        roomId: req.body?.source?.roomId,
        text: buildErrorMessage(
          typeof error.message === "string" ? error.message : "不明なエラー"
        )
      });
    } catch (replyError) {
      console.error("返信エラー:", replyError.message || replyError);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
