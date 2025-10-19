import { randomUUID } from 'node:crypto';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import PDFDocument from 'pdfkit';

import { env } from './env.js';

type GenerateQuotePdfInput = {
  leadId: string;
  packageKey: string;
  amountLow: number;
  amountHigh: number;
};

type GenerateQuotePdfResult = {
  url: string;
  key: string;
};

let s3Client: S3Client | null = null;

export async function generateQuotePdf({
  leadId,
  packageKey,
  amountLow,
  amountHigh
}: GenerateQuotePdfInput): Promise<GenerateQuotePdfResult> {
  const client = getS3Client();
  const pdfBuffer = await createQuotePdfBuffer({ leadId, packageKey, amountLow, amountHigh });

  const key = `quotes/${leadId}/${packageKey}-${Date.now()}-${randomUUID()}.pdf`;
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: pdfBuffer,
    ContentType: 'application/pdf',
    Metadata: {
      leadId,
      packageKey
    }
  });

  await client.send(command);
  const url = buildObjectUrl(key);

  return { url, key };
}

async function createQuotePdfBuffer({
  leadId,
  packageKey,
  amountLow,
  amountHigh
}: GenerateQuotePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('error', (error) => reject(error));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(20).text('Buildora Renovations', { align: 'center' });
    doc.moveDown();

    doc.fontSize(14).text(`Quote for Lead ${leadId}`);
    doc.moveDown();

    doc.fontSize(12).text(`Package: ${packageKey}`);
    doc.text(`Estimated Budget: ₹${amountLow.toLocaleString('en-IN')} – ₹${amountHigh.toLocaleString('en-IN')}`);
    doc.moveDown();

    doc
      .fontSize(11)
      .text(
        'This estimate covers design consultation, material selection, and on-site execution. ' +
          'Final pricing will be shared post detailed site survey.'
      );

    doc.moveDown();
    doc.text(`Generated on: ${new Date().toLocaleString('en-IN', { timeZone: env.TIMEZONE })}`);

    doc.end();
  });
}

function getS3Client(): S3Client {
  if (s3Client) {
    return s3Client;
  }
  if (!env.S3_BUCKET) {
    throw new Error('S3_BUCKET must be configured to store quote PDFs');
  }
  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error('S3 access key and secret key must be configured');
  }

  s3Client = new S3Client({
    forcePathStyle: true,
    endpoint: env.S3_ENDPOINT,
    region: 'auto',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY
    }
  });
  return s3Client;
}

function buildObjectUrl(key: string): string {
  if (env.S3_ENDPOINT) {
    const endpointUrl = new URL(env.S3_ENDPOINT);
    endpointUrl.pathname = `${endpointUrl.pathname.replace(/\/+$/, '')}/${key}`;
    return endpointUrl.toString();
  }
  return `https://${env.S3_BUCKET}.s3.amazonaws.com/${key}`;
}

export const __internal = {
  resetClient() {
    s3Client = null;
  }
};
