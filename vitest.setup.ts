const testPrivateKey = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCrB1ooly1VPg5h',
  '3vnfP4XndBcU7OeBJAbhlxzOA3g5T/OWk8+N63S1LCKdrnrPk4d3w467IrVAGim8',
  'qKO2a11BjVhKcw5EBhpm87dOuFOEdDaVXCRMG4i1mq8xog8+1dZAlF1Ze/0WT3CK',
  'L+Xr59rpPzskbGm/UMYxm0aKZK6MwRC7v4DwVJ2kwmVcojwr01DQxhyElpo6JgF2',
  'vuAy9KboWdzqnCHFC3DBUmhngpta4MJ+6GMhuncxSaOepik7Ra7YL7ooLqEnVgZT',
  'xMg0LBTuX0xcS9s2LWpmil9ZhnQ9JeWcy1oEfUGWIJEaqdMfSHOM+BtY+70IM8V+',
  '0bauF871AgMBAAECggEAa/7FgJINjyETZdutvrnW7RMSLCV3/cTpD3QjPTdVqCMD',
  'Npb5Xa1LUcefyB/P7tlClm6G50YAW4zpw/ZdAiiDh4wgL0q9vFh6PX4xxuR/4Eid',
  '2uyHAwPz7HDTpaymoc/XbYoB9Cpl4rug3bFnJvKN+fDygIpwr9zqeZKKFYOD8N5E',
  'S8K6XFQO+VJMLTMMqf3ISsR3NgQgWlc3zScGeayXhlOXuyTE6ywIDoXN15PJ4dBA',
  'LANvpUfhnaNshCviJNJTdSWNtm7Ww+fCbYySK0cbGSJTfz2G0Repd3eTvWTyvMK4',
  'B6zlDTFM9H05zvTO2QmYcCmwf2+H3gdX40qkdOWP4QKBgQDVQDrgz6IzvTWklkvA',
  '8hm13NQ0FKSwKHcW48Le3OeWfrxFBG1FDXePFwvZk6tv6IRqEqrSZDAw+FXa+1rg',
  'UlhKhMIk6iBU029VPGri8Tieid5c/WZgnQruEJP633YV/9Q0bKGPEsNrbfuMniHY',
  'ZOopnWWONhxn+HLZf24yjNBG+QKBgQDNUFUon76pCzefcN56TbJ9T9QteKpR9K93',
  'Syon67lCc9pXNNYfOXFt+zpc4nd+Dv4JxVqZVBaejQC2NkFRKGTZqUQ6y5jRAMAV',
  'CD0NK0mVTy8FUltkX7MpwBdYOn284fjcXvfGBQGAdKdCFi8sOVw+lGHU4ctWPVgO',
  'LAZDEs9a3QKBgBjixfw2PteK3Re38l8x4Y43lwv83Lsx/bPOII+hd+U4JQBo49eL',
  'Gsi4B8n8UaVdnRZD12t2BamxUVOcwZ4r/eG0XHOyXtOHWRa5Vj/lppXZwPlZGPlt',
  'Wjkt9hbwvPcUQ89aXgA0UFnZG+HtEkYOgMUaeR9/cRExDTYUiOedRzEBAoGAAeOa',
  'VPxbSbzjryDfuypZ2RNR9XUlxAlHUAauBZ4Cn1znhmPjEHh71bI5ED+5L7y9k6Nw',
  'OPbwGldbyVFoenGvs9z91rim2E10dv0TarqaO7h1y0u9sYe740d0L4iiPYmqu4RY',
  'LUdAg0kPfOktV+/TLHQ7DjVhpJJ96+t1x0o2BDUCgYAycRCFDSDTiG/cNfv1V0oJ',
  'qmzJxXehllZeJdd8IXeWCuvlDqqoyRcMaDeKNmUMB3dDJlC2P53zxFjcywnXhfi4',
  'tGrmsLq0eHPp6mZDLpvqyCoIlxT1eDpUBVtY7OLWDU7i54UitZ1WayA0MXAkqDET',
  'WPltoN3BOJe3tZtTjCEp0w==',
  '-----END PRIVATE KEY-----'
].join('\\n');

const serviceAccount = {
  type: 'service_account',
  project_id: 'buildora-test',
  private_key_id: 'test-private-key-id',
  private_key: testPrivateKey,
  client_email: 'buildora-test@buildora.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token'
};

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.TIMEZONE = process.env.TIMEZONE ?? 'Asia/Kolkata';
process.env.WA_TOKEN = process.env.WA_TOKEN ?? 'test-wa-token';
process.env.WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID ?? '123456789';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'sha256:changeme';
process.env.GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID ?? 'calendar-id';
process.env.GCAL_CREDENTIALS_JSON_BASE64 =
  process.env.GCAL_CREDENTIALS_JSON_BASE64 ??
  Buffer.from(JSON.stringify(serviceAccount), 'utf8').toString('base64');
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'https://example.com';
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'test-access-key';
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? 'test-secret-key';
process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'buildora-docs';
process.env.WA_APP_SECRET = process.env.WA_APP_SECRET ?? 'test-app-secret';
process.env.MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3005';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
process.env.WA_TEMPLATE_INTRO = process.env.WA_TEMPLATE_INTRO ?? 'buildora_intro';
process.env.WA_TEMPLATE_NUDGE1 = process.env.WA_TEMPLATE_NUDGE1 ?? 'buildora_nudge1';
process.env.WA_TEMPLATE_NUDGE2 = process.env.WA_TEMPLATE_NUDGE2 ?? 'buildora_nudge2';
process.env.WA_TEMPLATE_LANGUAGE = process.env.WA_TEMPLATE_LANGUAGE ?? 'en';

export {};
