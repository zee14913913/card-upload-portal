// Vercel Serverless Function to forward uploads to Make.com webhooks
const formidable = require('formidable');
const FormData = require('form-data');
const fetch = require('node-fetch');
const fs = require('fs');

// Disable body parsing, need raw body for formidable
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

    // Get upload type to determine webhook URL
    const uploadType = Array.isArray(fields.uploadType) ? fields.uploadType[0] : fields.uploadType;
    const clientName = Array.isArray(fields.clientName) ? fields.clientName[0] : fields.clientName;
    const paymentBy = Array.isArray(fields.paymentBy) ? fields.paymentBy[0] : fields.paymentBy;

    // Determine webhook URL based on upload type
    const STATEMENT_WEBHOOK = 'https://hook.us2.make.com/eok25ucrxrlx3tj82rby58dxxt10qo';
    const TRANSACTION_WEBHOOK = 'https://hook.us2.make.com/xxlrqohm3edmerdjznm1c9pb49w';
    
    const webhookUrl = uploadType === 'statement' ? STATEMENT_WEBHOOK : TRANSACTION_WEBHOOK;

    // Get the uploaded file
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Create new FormData for forwarding
    const formData = new FormData();
    formData.append('uploadType', uploadType);
    formData.append('clientName', clientName);
    if (paymentBy) {
      formData.append('paymentBy', paymentBy);
    }
    formData.append('file', fs.createReadStream(file.filepath), {
      filename: file.originalFilename || file.newFilename,
      contentType: file.mimetype,
    });

    // Forward to Make.com webhook
    const response = await fetch(webhookUrl, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
    });

    // Get response from webhook
    const result = await response.text();

    // Clean up temp file
    if (file.filepath) {
      fs.unlink(file.filepath, (err) => {
        if (err) console.error('Error deleting temp file:', err);
      });
    }

    // Return response
    if (response.ok) {
      res.status(200).json({ 
        success: true, 
        message: 'File uploaded successfully',
        webhookResponse: result 
      });
    } else {
      res.status(response.status).json({ 
        error: 'Webhook request failed',
        details: result 
      });
    }

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed', 
      message: error.message 
    });
  }
}
