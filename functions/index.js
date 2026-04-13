const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const OpenAI = require("openai");

admin.initializeApp();

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_KEY
  });
}

// =========================
// IMAGE PARSER (FIXED)
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
- purchasePrice (ONLY property price, ignore phone numbers, IDs, dates)

Rules:
- ignore phone numbers
- ignore reference numbers
- ignore unrelated numbers
- if multiple prices exist, choose the main property price

Return strict JSON:
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

    const parsed = JSON.parse(res.choices[0].message.content);
    return sanitizeDeal(parsed);

  } catch (e) {
    console.error("IMAGE ERROR:", e);
    return null;
  }
}

// =========================
// TEXT PARSER (SIMPLE)
// =========================
function parseText(text) {

  const sizeMatch = text.match(/(\d+)\s*(sqm|m2|m²)/i);
  const priceMatch = text.match(/(\d[\d,\.]*)/g);

  return {
    location: text.replace(/\d.*$/, "").trim(),
    size: sizeMatch ? Number(sizeMatch[1]) : null,
    purchasePrice: priceMatch ? Number(priceMatch[priceMatch.length - 1].replace(/,/g, "")) : null
  };
}

function sanitizeDeal(d = {}) {
  if (d.purchasePrice && d.purchasePrice < 1000) {
    d.purchasePrice = null;
  }

  if (d.size && d.size < 10) {
    d.size = null;
  }

  return d;
}

// =========================
// TEXT PARSER (AI)
// =========================
async function extractDealFromText(text) {
  const openai = getOpenAI();

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: `
Extract real estate deal data.

Return JSON:
{
  "location": string | null,
  "size": number | null,
  "purchasePrice": number | null,
  "reply": string
}
`
      },
      {
        role: "user",
        content: text
      }
    ],
    response_format: { type: "json_object" }
  });

  const parsed = JSON.parse(res.choices[0].message.content);
  return sanitizeDeal(parsed);
}

// =========================
// MERGE DEAL STATE (NEW)
// =========================
// Combines previously collected deal data with newly extracted fields.
// Priority: newData → oldDeal → null
// Used for conversational data collection across multiple user messages.
function mergeDeal(oldDeal = {}, newData = {}) {
  return {
    location: newData.location || oldDeal.location || null,
    size: newData.size || oldDeal.size || null,
    purchasePrice: newData.purchasePrice || oldDeal.purchasePrice || null
  };
}
// =========================
// MISSING FIELDS + QUESTIONS (NEW)
// =========================
// Detects which required deal fields are missing
// and generates the next question for the user.
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

function preview(deal) {
  const c = calculate(deal);

  return `Deal Preview

Location: ${deal.location}
Size: ${deal.size} sqm
Price: €${deal.purchasePrice}

GDV: €${c.gdv}
Cost: €${c.cost}
Profit: €${c.profit}

ROI: ${c.roi}%
Margin: ${c.margin}%`;
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

    // =========================
    // SAVE
    // =========================
    if (msg.action === "save" && pendingDeal) {

      await dealsRef.add({
        ...pendingDeal,
        createdAt: FieldValue.serverTimestamp()
      });

      await userRef.update({
        pendingDeal: FieldValue.delete()
      });

      await send(db, userId, "Deal saved", sessionId, "status");
      return;
    }

    // =========================
    // IMAGE
    // =========================
    if (msg.imageBase64) {

      const parsed = await extractDealFromImage(msg.imageBase64);

      if (parsed?.location && parsed?.size && parsed?.purchasePrice) {

        await userRef.set({ pendingDeal: parsed }, { merge: true });

        await sendStructured(db, userId, parsed, sessionId);
      }


      return;
    }

   // =========================
   // TEXT (AI + STATE MERGE)
   // =========================
   if (msg.text) {

     let parsed;

     try {
       parsed = await extractDealFromText(msg.text);
     } catch (e) {
       console.error("AI TEXT ERROR:", e);

       // fallback на старый парсер
       parsed = parseText(msg.text);
     }

     // 🔥 объединяем с предыдущими данными
     const merged = mergeDeal(pendingDeal, parsed);

     // сохраняем состояние
     await userRef.set({ pendingDeal: merged }, { merge: true });

     const missing = getMissingFields(merged);

     if (missing.length === 0) {

       await sendStructured(db, userId, merged, sessionId);

     } else {

       const question = generateQuestion(missing);

       await send(db, userId, question, sessionId);
     }
   }has

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
// SEND STRUCTURED (NEW)
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
  }
);