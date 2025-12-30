// Vercel Serverless Function with OpenAI Vision OCR
const formidable = require('formidable');
const fetch = require('node-fetch');
const fs = require('fs');

// Disable body parsing
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Parse form data
    const form = new formidable.IncomingForm();
    
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve({ fields, files });
      });
    });

    // Get form fields
    const uploadType = Array.isArray(fields.uploadType) ? fields.uploadType[0] : fields.uploadType;
    const clientName = Array.isArray(fields.clientName) ? fields.clientName[0] : fields.clientName;
    const paymentBy = Array.isArray(fields.paymentBy) ? fields.paymentBy[0] : fields.paymentBy;

    // Get the uploaded file
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Read file and convert to base64
    const fileBuffer = fs.readFileSync(file.filepath);
    const base64Image = fileBuffer.toString('base64');
    const mimeType = file.mimetype || 'image/jpeg';

    // Determine OCR prompt based on upload type
    const prompt = uploadType === 'statement' 
      ? `Extract credit card statement information from this image. Return ONLY a JSON object with these exact fields:
{
  "clientName": "client name from statement or use provided",
  "bank": "bank name",
  "cardType": "card type (e.g., Visa, Mastercard)",
  "cardNumber": "last 4 digits only",
  "currency": "currency code (default MYR)",
  "statementPeriodStart": "YYYY-MM-DD",
  "statementPeriodEnd": "YYYY-MM-DD",
  "statementDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD",
  "dueAmount": "numeric amount",
  "outstandingBal": "numeric amount"
}`
      : `Extract transaction information from this receipt/statement. Return ONLY a JSON object with these exact fields:
{
  "date": "YYYY-MM-DD",
  "bank": "bank name",
  "cardType": "card type",
  "cardNumber": "last 4 digits",
  "currency": "currency code",
  "cashOutAmount": "numeric amount",
  "installmentPlan": "installment details or empty",
  "point": "points earned or empty",
  "category": "transaction category",
  "transactionId": "transaction reference number"
}`;

    // Call OpenAI Vision API
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 1000
      })
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      throw new Error(`OpenAI API failed: ${errorText}`);
    }

    const openaiData = await openaiResponse.json();
    const extractedText = openaiData.choices[0].message.content;

    // Parse JSON from OpenAI response
    let extractedData;
    try {
      // Remove markdown code blocks if present
      const cleanedText = extractedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(cleanedText);
    } catch (parseError) {
      throw new Error(`Failed to parse OpenAI response: ${extractedText}`);
    }

    // Prepare data for Make webhook
    const webhookData = uploadType === 'statement' 
      ? {
          recordType: 'statement',
          clientName: extractedData.clientName || clientName,
          bank: extractedData.bank,
          cardType: extractedData.cardType,
          cardNumber: extractedData.cardNumber,
          currency: extractedData.currency || 'MYR',
          statementPeriodStart: extractedData.statementPeriodStart,
          statementPeriodEnd: extractedData.statementPeriodEnd,
          statementDate: extractedData.statementDate,
          dueDate: extractedData.dueDate,
          dueAmount: extractedData.dueAmount,
          outstandingBal: extractedData.outstandingBal
        }
      : {
          recordType: 'transaction',
          date: extractedData.date,
          clientName: clientName,
          bank: extractedData.bank,
          cardType: extractedData.cardType,
          cardNumber: extractedData.cardNumber,
          currency: extractedData.currency || 'MYR',
          cashOutAmount: extractedData.cashOutAmount,
          paymentBy: paymentBy,
          installmentPlan: extractedData.installmentPlan,
          point: extractedData.point,
          category: extractedData.category,
          transactionId: extractedData.transactionId
        };

    // Determine webhook URL
    const STATEMENT_WEBHOOK = 'https://hook.us2.make.com/eok25ucrxrlx3tj82rby58dxxt10qo';
    const TRANSACTION_WEBHOOK = 'https://hook.us2.make.com/xxlrqohm3edmerdjznm1c9pb49w';
    const webhookUrl = uploadType === 'statement' ? STATEMENT_WEBHOOK : TRANSACTION_WEBHOOK;

    // Send JSON data to Make webhook
    const makeResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(webhookData)
    });

    const makeResult = await makeResponse.text();

    // Clean up temp file
    if (file.filepath) {
      fs.unlink(file.filepath, (err) => {
        if (err) console.error('Error deleting temp file:', err);
      });
    }

    // Return response
    if (makeResponse.ok) {
      res.status(200).json({ 
        success: true, 
        message: 'File processed successfully',
        extractedData: extractedData,
        makeResponse: makeResult
      });
    } else {
      res.status(makeResponse.status).json({ 
        error: 'Make webhook failed',
        details: makeResult
      });
    }

  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ 
      error: 'Processing failed', 
      message: error.message 
    });
  }
}
