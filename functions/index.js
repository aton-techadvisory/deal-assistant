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
              text: "Extract location, size (sqm), purchasePrice. Return JSON."
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

    return JSON.parse(res.choices[0].message.content);

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

  return JSON.parse(res.choices[0].message.content);
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
    // TEXT (AI)
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

      const hasAllFields =
        parsed.location &&
        parsed.size &&
        parsed.purchasePrice;

      if (hasAllFields) {

        await userRef.set({ pendingDeal: parsed }, { merge: true });

        await sendStructured(db, userId, parsed, sessionId);

      } else {

        const reply =
          parsed.reply ||
          "Please provide location, size and price.";

        await send(db, userId, reply, sessionId);
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