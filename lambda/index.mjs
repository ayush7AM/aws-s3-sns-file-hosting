// File hosting API: returns short-lived presigned URLs so the browser can
// upload/download directly to a PRIVATE S3 bucket. Lambda never touches file bytes.
import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = process.env.BUCKET_NAME;           // set in Lambda configuration
const PREFIX = "uploads/";                         // all user files live under this folder
const URL_TTL_SECONDS = 300;                       // presigned links expire after 5 minutes
const s3 = new S3Client({});

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },  // CORS headers are added by the Function URL config
  body: JSON.stringify(body),
});

// Keep names safe: strip paths and odd characters, add a timestamp to avoid overwrites
const safeName = (name = "") =>
  `${Date.now()}-${name.split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file"}`;

export const handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method || "GET";
    const qs = event.queryStringParameters || {};
    const action = qs.action;

    // GET ?action=list  -> list uploaded files
    if (method === "GET" && action === "list") {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
      const files = (out.Contents || [])
        .filter((o) => o.Key !== PREFIX)
        .map((o) => ({ key: o.Key, name: o.Key.slice(PREFIX.length), size: o.Size, lastModified: o.LastModified }))
        .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
      return json(200, { files });
    }

    // POST ?action=upload-url  body: {"filename": "...", "contentType": "..."}
    if (method === "POST" && action === "upload-url") {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body || "{}";
      const { filename, contentType } = JSON.parse(raw);
      if (!filename) return json(400, { error: "filename is required" });
      const key = PREFIX + safeName(filename);
      const type = contentType || "application/octet-stream";
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: type }),
        { expiresIn: URL_TTL_SECONDS });
      return json(200, { uploadUrl: url, key, contentType: type, expiresIn: URL_TTL_SECONDS });
    }

    // GET ?action=download-url&key=uploads/...  -> presigned download link
    if (method === "GET" && action === "download-url") {
      const key = qs.key;
      if (!key || !key.startsWith(PREFIX) || key.includes("..")) return json(400, { error: "invalid key" });
      const fileName = key.slice(PREFIX.length);
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: BUCKET, Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName}"`,
      }), { expiresIn: URL_TTL_SECONDS });
      return json(200, { downloadUrl: url, expiresIn: URL_TTL_SECONDS });
    }

    return json(404, { error: "Unknown route. Use ?action=list | upload-url | download-url" });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Internal error", detail: err.name });
  }
};
