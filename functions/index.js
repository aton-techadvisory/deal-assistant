const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const OpenAI = require("openai");
const { getStorage } = require("firebase-admin/storage");

admin.initializeApp();

const bucket = getStorage().bucket();

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_KEY
  });
}

// =========================
// IMAGE PARSER
// =========================
async function extractDealFromImage(base64) {
  try {
    const openai = getOpenAI();

    const imageData = base64.startsWith("data:image")
      ? base64
      : `data:image/jpeg;base64,${base64}`;

    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract real estate deal data from this image.

The image may be:
- a screenshot
- a chat conversation
- a property listing
- a document

Find and return:
- location (address or city)
- size in sqm (numbers near sqm, m2, m²)
- purchasePrice (ONLY property price)

Ignore:
- phone numbers
- IDs
- unrelated numbers

Return JSON:
{
  "location": string | null,
  "size": number | null,
  "purchasePrice": number | null
}`
            },
            {
              type: "image_url",
              image_url: { url: imageData }
            }
          ]
        }
      ],
      response_format: { type: "json_object" }
    });

    return sanitizeDeal(JSON.parse(res.choices[0].message.content));

  } catch (e) {
    console.error("IMAGE ERROR:", e);
    return null;
  }
}

// =========================
// TEXT PARSER (fallback)
// =========================
function parseText(text) {
  const sizeMatch = text.match(/(\d+)\s*(sqm|m2|m²)/i);
  const priceMatch = text.match(/(\d[\d,\.]*)/g);

  return {
    location: text.replace(/\d.*$/, "").trim(),
    size: sizeMatch ? Number(sizeMatch[1]) : null,
    purchasePrice: priceMatch ? Number(priceMatch.pop()?.replace(/,/g, "")) : null
  };
}

// =========================
// SANITIZE
// =========================
function sanitizeDeal(d = {}) {
  if (d.purchasePrice && d.purchasePrice < 1000) d.purchasePrice = null;
  if (d.size && d.size < 10) d.size = null;
  return d;
}

// =========================
// TEXT AI
// =========================
async function extractDealFromText(text) {
  const openai = getOpenAI();

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: `Extract real estate deal data.
Return JSON:
{
  "location": string | null,
  "size": number | null,
  "purchasePrice": number | null
}`
      },
      {
        role: "user",
        content: text
      }
    ],
    response_format: { type: "json_object" }
  });

  return sanitizeDeal(JSON.parse(res.choices[0].message.content));
}

// =========================
// MERGE
// =========================
function mergeDeal(oldDeal = {}, newData = {}) {
  return {
    location: newData.location || oldDeal.location || null,
    size: newData.size || oldDeal.size || null,
    purchasePrice: newData.purchasePrice || oldDeal.purchasePrice || null
  };
}

// =========================
// MISSING
// =========================
function getMissingFields(deal) {
  const missing = [];
  if (!deal.location) missing.push("location");
  if (!deal.size) missing.push("size");
  if (!deal.purchasePrice) missing.push("purchasePrice");
  return missing;
}

function generateQuestion(missing) {
  if (missing.includes("location")) return "What is the location?";
  if (missing.includes("size")) return "What is the size in sqm?";
  if (missing.includes("purchasePrice")) return "What is the purchase price?";
  return "Please provide missing deal details.";
}

// =========================
// CALC
// =========================
function calculate(d) {
  const gdv = d.size * 2500;
  const cost = d.size * 1000;
  const total = cost + d.purchasePrice;
  const profit = gdv - total;

  return {
    gdv,
    cost,
    profit,
    roi: Math.round((profit / total) * 100),
    margin: Math.round((profit / gdv) * 100)
  };
}

// =========================
// HTML REPORT
// =========================
function generateHTMLReport(deal) {
  const c = calculate(deal);

  return `
<html>
<head>
  <title>Deal Report</title>
</head>
<body>
  <h1>Deal Report</h1>

  <p><b>Location:</b> ${deal.location}</p>
  <p><b>Size:</b> ${deal.size} sqm</p>
  <p><b>Price:</b> €${deal.purchasePrice}</p>

  <hr/>

  <p><b>GDV:</b> €${c.gdv}</p>
  <p><b>Cost:</b> €${c.cost}</p>
  <p><b>Profit:</b> €${c.profit}</p>

  <p><b>ROI:</b> ${c.roi}%</p>
  <p><b>Margin:</b> ${c.margin}%</p>

</body>
</html>`;
}

// =========================
// UPLOAD REPORT
// =========================
async function uploadReport(dealId, html) {
  const file = bucket.file(`reports/${dealId}.html`);

  await file.save(html, {
    contentType: "text/html",
    public: true
  });

  return `https://storage.googleapis.com/${bucket.name}/reports/${dealId}.html`;
}

// =========================
// MAIN
// =========================
exports.chatHandler = onDocumentCreated(
  {
    document: "users/{userId}/messages/{messageId}",
    secrets: ["OPENAI_KEY"]
  },
  async (event) => {

    const db = admin.firestore();
    const userId = event.params.userId;

    const userRef = db.collection("users").doc(userId);
    const dealsRef = userRef.collection("deals");

    const msg = event.data.data();
    if (!msg || msg.role !== "user") return;

    const sessionId = msg.sessionId;

    const userDoc = await userRef.get();
    const pendingDeal = userDoc.data()?.pendingDeal;

    // EDIT
    if (msg.action === "edit") {
      await send(
        db,
        userId,
        "What do you want to change? (location, size, price)",
        sessionId
      );
      return;
    }

    // SAVE
    if (msg.action === "save" && pendingDeal) {

      const docRef = dealsRef.doc();
      const dealId = docRef.id;

      const htmlReport = generateHTMLReport(pendingDeal);
      const reportUrl = await uploadReport(dealId, htmlReport);

      await docRef.set({
        ...pendingDeal,
        reportHTML: htmlReport,
        reportUrl: reportUrl,
        createdAt: FieldValue.serverTimestamp()
      });

      await userRef.update({
        pendingDeal: FieldValue.delete()
      });

      await send(db, userId, "Deal saved", sessionId, "status");
      return;
    }

    // IMAGE
    if (msg.imageBase64) {
      const parsed = await extractDealFromImage(msg.imageBase64);

      if (parsed?.location && parsed?.size && parsed?.purchasePrice) {
        await userRef.set({ pendingDeal: parsed }, { merge: true });
        await sendStructured(db, userId, parsed, sessionId);
      }

      return;
    }

    // TEXT
    if (msg.text) {

      let parsed;

      try {
        parsed = await extractDealFromText(msg.text);
      } catch (e) {
        parsed = parseText(msg.text);
      }

      const merged = mergeDeal(pendingDeal, parsed);
      await userRef.set({ pendingDeal: merged }, { merge: true });

      const missing = getMissingFields(merged);

      if (missing.length === 0) {
        await sendStructured(db, userId, merged, sessionId);
      } else {
        await send(db, userId, generateQuestion(missing), sessionId);
      }
    }
  }
);

// =========================
// SEND
// =========================
async function send(db, userId, text, sessionId, type = "") {
  await db.collection("users")
    .doc(userId)
    .collection("messages")
    .add({
      text,
      type,
      role: "assistant",
      sessionId,
      createdAt: FieldValue.serverTimestamp()
    });
}

// =========================
// SEND STRUCTURED
// =========================
async function sendStructured(db, userId, deal, sessionId) {
  const c = calculate(deal);

  await db.collection("users")
    .doc(userId)
    .collection("messages")
    .add({
      type: "preview",
      role: "assistant",
      sessionId,
      deal: {
        ...deal,
        ...c
      },
      createdAt: FieldValue.serverTimestamp()
    });
}