import { useEffect, useState, useDeferredValue, useRef } from "react";
import JSZip from "jszip";
import Papa from "papaparse";
import QRCode from "qrcode";

const ERROR_LEVELS = [
  { value: "L", label: "Low (L)" },
  { value: "M", label: "Medium (M)" },
  { value: "Q", label: "Quartile (Q)" },
  { value: "H", label: "High (H)" }
];

const DEFAULT_TEXT = "https://bamsense.works";
const DEFAULT_TEMPLATE_DATA = {
  url: DEFAULT_TEXT,
  wifiSsid: "",
  wifiPassword: "",
  wifiType: "WPA",
  wifiHidden: false,
  emailTo: "",
  emailSubject: "",
  emailBody: "",
  smsTo: "",
  smsBody: "",
  vName: "",
  vOrg: "",
  vTitle: "",
  vPhone: "",
  vEmail: "",
  vUrl: "",
  vAddress: ""
};

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const parseHexColor = (value) => {
  const normalized = String(value || "").trim().replace("#", "");
  if (!normalized) {
    return null;
  }
  const hex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
};

const toLinearChannel = (channel) => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
};

const getRelativeLuminance = (color) => {
  const rgb = parseHexColor(color);
  if (!rgb) {
    return null;
  }
  const r = toLinearChannel(rgb.r);
  const g = toLinearChannel(rgb.g);
  const b = toLinearChannel(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const getContrastRatio = (colorA, colorB) => {
  const luminanceA = getRelativeLuminance(colorA);
  const luminanceB = getRelativeLuminance(colorB);
  if (luminanceA === null || luminanceB === null) {
    return null;
  }
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
};

const getContrastAssessment = (ratio) => {
  if (!ratio || Number.isNaN(ratio)) {
    return null;
  }
  if (ratio >= 4.5) {
    return {
      label: "Strong",
      className: "good",
      message: "Great scan reliability."
    };
  }
  if (ratio >= 3) {
    return {
      label: "Okay",
      className: "ok",
      message: "Usable, but higher contrast scans better."
    };
  }
  return {
    label: "Low",
    className: "low",
    message: "Increase contrast for better scans."
  };
};

const getModuleAssessment = (modulePx) => {
  if (!modulePx || Number.isNaN(modulePx)) {
    return null;
  }
  if (modulePx >= 4) {
    return {
      label: "Strong",
      className: "good",
      message: "Great for print and distance scans."
    };
  }
  if (modulePx >= 3) {
    return {
      label: "Okay",
      className: "ok",
      message: "Likely scannable, but larger is safer."
    };
  }
  return {
    label: "Small",
    className: "low",
    message: "Increase size or shorten the payload."
  };
};

const getQuietZoneAssessment = (margin) => {
  if (margin >= 4) {
    return {
      label: "Safe",
      className: "good",
      message: "Meets the 4-module quiet zone."
    };
  }
  if (margin >= 2) {
    return {
      label: "Tight",
      className: "ok",
      message: "Some scanners prefer a larger margin."
    };
  }
  return {
    label: "Risky",
    className: "low",
    message: "Increase margin to 4+ modules."
  };
};

const getPayloadAssessment = (bytes) => {
  if (!bytes || Number.isNaN(bytes)) {
    return null;
  }
  if (bytes <= 120) {
    return {
      label: "Compact",
      className: "good",
      message: "Short payloads scan faster and at smaller sizes."
    };
  }
  if (bytes <= 220) {
    return {
      label: "Medium",
      className: "ok",
      message: "Consider shortening for smaller codes."
    };
  }
  return {
    label: "Dense",
    className: "low",
    message: "Large payloads require bigger QR sizes."
  };
};

const TEMPLATE_OPTIONS = [
  { value: "plain", label: "Plain text" },
  { value: "url", label: "Website / URL" },
  { value: "wifi", label: "WiFi" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "vcard", label: "vCard" }
];

const TEMPLATE_FIELD_KEYS = {
  url: ["url"],
  wifi: ["wifiSsid", "wifiPassword", "wifiType", "wifiHidden"],
  email: ["emailTo", "emailSubject", "emailBody"],
  sms: ["smsTo", "smsBody"],
  vcard: ["vName", "vOrg", "vTitle", "vPhone", "vEmail", "vUrl", "vAddress"]
};

const BULK_MAX_ROWS = 250;
const HISTORY_LIMIT = 10;
const TRANSPARENT_BG = "#ffffff00";
const PRESET_STORAGE_KEY = "bamsense-qr-presets";
const PRESET_LIMIT = 12;
const SHARE_PARAM = "s";

const BULK_FIELDS = {
  plain: [{ key: "payload", label: "Payload column", required: true }],
  url: [{ key: "url", label: "URL column", required: true }],
  wifi: [
    { key: "wifiSsid", label: "SSID column", required: true },
    { key: "wifiPassword", label: "Password column" },
    { key: "wifiType", label: "Encryption column" },
    { key: "wifiHidden", label: "Hidden column" }
  ],
  email: [
    { key: "emailTo", label: "To column", required: true },
    { key: "emailSubject", label: "Subject column" },
    { key: "emailBody", label: "Body column" }
  ],
  sms: [
    { key: "smsTo", label: "Phone column", required: true },
    { key: "smsBody", label: "Message column" }
  ],
  vcard: [
    { key: "vName", label: "Full name column" },
    { key: "vOrg", label: "Organization column" },
    { key: "vTitle", label: "Title column" },
    { key: "vPhone", label: "Phone column" },
    { key: "vEmail", label: "Email column" },
    { key: "vUrl", label: "Website column" },
    { key: "vAddress", label: "Address column" }
  ]
};

const normalizeHeader = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const findColumn = (columns, candidates) => {
  const normalized = columns.map((column) => ({
    raw: column,
    normalized: normalizeHeader(column)
  }));
  for (const candidate of candidates) {
    const match = normalized.find((entry) => entry.normalized === candidate);
    if (match) {
      return match.raw;
    }
  }
  return "";
};

const autoMapColumns = (template, columns) => {
  const normalizedColumns = columns.map((column) => normalizeHeader(column));
  const hasColumn = (candidate) => normalizedColumns.includes(candidate);
  const pick = (candidates) => findColumn(columns, candidates);

  if (template === "plain") {
    return {
      payload: pick(["payload", "text", "data", "url", "link"])
    };
  }

  if (template === "url") {
    return { url: pick(["url", "link", "website", "page"]) };
  }

  if (template === "wifi") {
    return {
      wifiSsid: pick(["ssid", "network", "wifi", "wifissid"]),
      wifiPassword: pick(["password", "pass", "wifipassword"]),
      wifiType: pick(["type", "encryption", "security"]),
      wifiHidden: pick(["hidden", "isHidden", "wifihidden"])
    };
  }

  if (template === "email") {
    return {
      emailTo: pick(["to", "email", "emailto", "recipient"]),
      emailSubject: pick(["subject", "emailsubject"]),
      emailBody: pick(["body", "message", "emailbody"])
    };
  }

  if (template === "sms") {
    return {
      smsTo: pick(["phone", "number", "sms", "smsto"]),
      smsBody: pick(["message", "body", "smsbody"])
    };
  }

  if (template === "vcard") {
    return {
      vName: pick(["name", "fullname", "full", "contact"]),
      vOrg: pick(["org", "organization", "company"]),
      vTitle: pick(["title", "role"]),
      vPhone: pick(["phone", "mobile", "tel"]),
      vEmail: pick(["email", "mail"]),
      vUrl: pick(["url", "website", "site"]),
      vAddress: pick(["address", "addr", "location"])
    };
  }

  if (hasColumn("payload")) {
    return { payload: pick(["payload"]) };
  }

  return {};
};

const autoPickFilename = (columns) =>
  findColumn(columns, ["filename", "file", "name", "label", "title"]);

const parseBoolean = (value) => {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value || "").trim().toLowerCase();
  return ["true", "yes", "1", "y"].includes(normalized);
};

const normalizeWifiType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "WPA";
  }
  if (["wpa", "wpa2", "wpa3"].includes(normalized)) {
    return "WPA";
  }
  if (["wep"].includes(normalized)) {
    return "WEP";
  }
  if (["nopass", "none", "open"].includes(normalized)) {
    return "nopass";
  }
  return "WPA";
};

const sanitizeFileName = (value) => {
  const base = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return base || "qr";
};

const getRowValue = (row, column) => {
  if (!column) {
    return "";
  }
  const value = row?.[column];
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
};

const buildPayloadFromRow = (template, row, map) => {
  if (template === "plain") {
    return getRowValue(row, map.payload);
  }
  const data = {
    url: getRowValue(row, map.url),
    wifiSsid: getRowValue(row, map.wifiSsid),
    wifiPassword: getRowValue(row, map.wifiPassword),
    wifiType: normalizeWifiType(getRowValue(row, map.wifiType)),
    wifiHidden: parseBoolean(getRowValue(row, map.wifiHidden)),
    emailTo: getRowValue(row, map.emailTo),
    emailSubject: getRowValue(row, map.emailSubject),
    emailBody: getRowValue(row, map.emailBody),
    smsTo: getRowValue(row, map.smsTo),
    smsBody: getRowValue(row, map.smsBody),
    vName: getRowValue(row, map.vName),
    vOrg: getRowValue(row, map.vOrg),
    vTitle: getRowValue(row, map.vTitle),
    vPhone: getRowValue(row, map.vPhone),
    vEmail: getRowValue(row, map.vEmail),
    vUrl: getRowValue(row, map.vUrl),
    vAddress: getRowValue(row, map.vAddress)
  };
  return buildTemplateText(template, data);
};

const escapeWifi = (value) => value.replace(/([\\;,:])/g, "\\$1");

const escapeVcard = (value) =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");

const buildTemplateText = (template, data) => {
  if (template === "url") {
    return data.url.trim();
  }

  if (template === "wifi") {
    const ssid = data.wifiSsid.trim();
    if (!ssid) {
      return "";
    }
    const type = data.wifiType || "WPA";
    const password = data.wifiPassword || "";
    const parts = [`WIFI:T:${type};`, `S:${escapeWifi(ssid)};`];
    if (type !== "nopass") {
      parts.push(`P:${escapeWifi(password)};`);
    }
    if (data.wifiHidden) {
      parts.push("H:true;");
    }
    parts.push(";");
    return parts.join("");
  }

  if (template === "email") {
    const to = data.emailTo.trim();
    if (!to) {
      return "";
    }
    const query = [];
    if (data.emailSubject.trim()) {
      query.push(`subject=${encodeURIComponent(data.emailSubject.trim())}`);
    }
    if (data.emailBody.trim()) {
      query.push(`body=${encodeURIComponent(data.emailBody.trim())}`);
    }
    return query.length ? `mailto:${to}?${query.join("&")}` : `mailto:${to}`;
  }

  if (template === "sms") {
    const to = data.smsTo.trim();
    if (!to) {
      return "";
    }
    const body = data.smsBody.trim();
    return body ? `SMSTO:${to}:${body}` : `SMSTO:${to}:`;
  }

  if (template === "vcard") {
    const hasAny = [
      data.vName,
      data.vOrg,
      data.vTitle,
      data.vPhone,
      data.vEmail,
      data.vUrl,
      data.vAddress
    ].some((value) => value.trim());
    if (!hasAny) {
      return "";
    }
    const lines = ["BEGIN:VCARD", "VERSION:3.0"];
    if (data.vName.trim()) {
      lines.push(`FN:${escapeVcard(data.vName.trim())}`);
    }
    if (data.vOrg.trim()) {
      lines.push(`ORG:${escapeVcard(data.vOrg.trim())}`);
    }
    if (data.vTitle.trim()) {
      lines.push(`TITLE:${escapeVcard(data.vTitle.trim())}`);
    }
    if (data.vPhone.trim()) {
      lines.push(`TEL:${escapeVcard(data.vPhone.trim())}`);
    }
    if (data.vEmail.trim()) {
      lines.push(`EMAIL:${escapeVcard(data.vEmail.trim())}`);
    }
    if (data.vUrl.trim()) {
      lines.push(`URL:${escapeVcard(data.vUrl.trim())}`);
    }
    if (data.vAddress.trim()) {
      lines.push(`ADR:;;${escapeVcard(data.vAddress.trim())};;;;`);
    }
    lines.push("END:VCARD");
    return lines.join("\n");
  }

  return data.text?.trim() ?? "";
};

const getTemplateLabel = (value) =>
  TEMPLATE_OPTIONS.find((option) => option.value === value)?.label ?? "Plain text";

const formatPayloadSnippet = (value) => {
  const text = String(value || "").trim();
  if (text.length <= 48) {
    return text || "(empty payload)";
  }
  return `${text.slice(0, 32)}...${text.slice(-10)}`;
};

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = src;
  });

const applyLogoOverlay = async (
  baseDataUrl,
  logoDataUrl,
  size,
  scale,
  safeArea
) => {
  if (!logoDataUrl) {
    return baseDataUrl;
  }
  const [qrImg, logoImg] = await Promise.all([
    loadImage(baseDataUrl),
    loadImage(logoDataUrl)
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return baseDataUrl;
  }
  ctx.drawImage(qrImg, 0, 0, size, size);
  const logoSize = Math.round(size * scale);
  const x = Math.round((size - logoSize) / 2);
  const y = Math.round((size - logoSize) / 2);
  if (safeArea) {
    const pad = Math.round(logoSize * 0.12);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(
      Math.max(0, x - pad),
      Math.max(0, y - pad),
      Math.min(size, logoSize + pad * 2),
      Math.min(size, logoSize + pad * 2)
    );
  }
  ctx.drawImage(logoImg, x, y, logoSize, logoSize);
  return canvas.toDataURL("image/png");
};

const createHistoryEntry = (entry) => {
  const createdAt = Date.now();
  const suffix = Math.random().toString(36).slice(2, 6);
  return {
    id: `${createdAt}-${suffix}`,
    createdAt,
    ...entry
  };
};

const loadPresets = () => {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const encodeSharePayload = (payload) => {
  try {
    return encodeURIComponent(JSON.stringify(payload));
  } catch {
    return "";
  }
};

const decodeSharePayload = (encoded) => {
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
};

const readShareFromLocation = () => {
  if (typeof window === "undefined") {
    return null;
  }
  const rawHash = window.location.hash.replace(/^#/, "");
  if (!rawHash) {
    return null;
  }
  const params = new URLSearchParams(rawHash);
  const rawPayload = params.get(SHARE_PARAM);
  if (!rawPayload) {
    return null;
  }
  return decodeSharePayload(rawPayload);
};

export default function App() {
  const [template, setTemplate] = useState("plain");
  const [textInput, setTextInput] = useState(DEFAULT_TEXT);
  const [templateData, setTemplateData] = useState(() => ({
    ...DEFAULT_TEMPLATE_DATA
  }));
  const payload = template === "plain" ? textInput : buildTemplateText(template, templateData);
  const deferredPayload = useDeferredValue(payload);
  const [size, setSize] = useState(280);
  const [margin, setMargin] = useState(2);
  const [errorCorrection, setErrorCorrection] = useState("M");
  const [fgColor, setFgColor] = useState("#274c6f");
  const [bgColor, setBgColor] = useState("#ffffff");
  const [transparentBg, setTransparentBg] = useState(false);
  const [logoDataUrl, setLogoDataUrl] = useState("");
  const [logoName, setLogoName] = useState("");
  const [logoScale, setLogoScale] = useState(0.22);
  const [logoSafeArea, setLogoSafeArea] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrSvg, setQrSvg] = useState("");
  const [status, setStatus] = useState("Ready");
  const [history, setHistory] = useState([]);
  const [exportScale, setExportScale] = useState(1);
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkColumns, setBulkColumns] = useState([]);
  const [bulkMap, setBulkMap] = useState({});
  const [bulkFilenameColumn, setBulkFilenameColumn] = useState("");
  const [bulkStatus, setBulkStatus] = useState("Upload a CSV to generate in bulk.");
  const [bulkIsGenerating, setBulkIsGenerating] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presets, setPresets] = useState(() => loadPresets());
  const [shareIncludePayload, setShareIncludePayload] = useState(true);
  const [shareUrl, setShareUrl] = useState("");
  const [qrStats, setQrStats] = useState(null);
  const statusTimeoutRef = useRef(null);
  const shareAppliedRef = useRef(false);
  const presetFileInputRef = useRef(null);
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") {
      return "light";
    }
    const saved = window.localStorage.getItem("bamsense-theme");
    if (saved === "light" || saved === "dark") {
      return saved;
    }
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  const effectiveBgColor = transparentBg ? TRANSPARENT_BG : bgColor;
  const contrastBgColor = transparentBg ? "#ffffff" : bgColor;
  const contrastRatio = getContrastRatio(fgColor, contrastBgColor);
  const contrastAssessment = getContrastAssessment(contrastRatio);
  const contrastBadgeClass = contrastAssessment?.className
    ? `contrast-badge ${contrastAssessment.className}`
    : "contrast-badge";
  const contrastLabel = contrastAssessment?.label ?? "Check";
  const contrastMessage =
    contrastAssessment?.message ??
    "Pick foreground and background colors to see scan contrast.";
  const contrastRatioLabel =
    contrastRatio === null ? "—" : `${contrastRatio.toFixed(2)}:1`;
  const quietZoneAssessment = getQuietZoneAssessment(margin);
  const quietZoneBadgeClass = quietZoneAssessment?.className
    ? `contrast-badge ${quietZoneAssessment.className}`
    : "contrast-badge";
  const quietZoneLabel = quietZoneAssessment?.label ?? "Check";
  const quietZoneMessage =
    quietZoneAssessment?.message ?? "Aim for a 4-module quiet zone.";
  const payloadAssessment = getPayloadAssessment(qrStats?.bytes);
  const payloadBadgeClass = payloadAssessment?.className
    ? `contrast-badge ${payloadAssessment.className}`
    : "contrast-badge";
  const payloadLabel = payloadAssessment?.label ?? "Check";
  const payloadMessage =
    payloadAssessment?.message ?? "Keep payloads short for easier scanning.";
  const moduleAssessment = getModuleAssessment(qrStats?.modulePx);
  const moduleBadgeClass = moduleAssessment?.className
    ? `contrast-badge ${moduleAssessment.className}`
    : "contrast-badge";
  const moduleBadgeLabel = moduleAssessment?.label ?? "Check";
  const moduleMessage =
    moduleAssessment?.message ?? "Generate a QR code to see scan diagnostics.";
  const hasQrStats = Boolean(qrStats && qrStats.modules);
  const modulePxLabel = hasQrStats ? `${qrStats.modulePx.toFixed(2)}px` : "—";
  const moduleGridLabel = hasQrStats
    ? `${qrStats.modules} × ${qrStats.modules}`
    : "—";
  const versionLabel = hasQrStats ? `v${qrStats.version}` : "—";
  const maskLabel = hasQrStats ? `Mask ${qrStats.maskPattern}` : "—";
  const bytesLabel = hasQrStats ? `${qrStats.bytes} bytes` : "—";
  const charsLabel = hasQrStats ? `${qrStats.chars} chars` : "—";
  const minSizePx = hasQrStats
    ? Math.ceil(3 * (qrStats.modules + margin * 2))
    : null;
  const idealSizePx = hasQrStats
    ? Math.ceil(4 * (qrStats.modules + margin * 2))
    : null;
  const minSizeLabel = hasQrStats ? `${minSizePx}px` : "—";
  const idealSizeLabel = hasQrStats ? `Ideal ${idealSizePx}px` : "";
  const printPx = size * exportScale;
  const printInches = printPx / 300;
  const printMm = printInches * 25.4;
  const printSizeLabel = `${printInches.toFixed(2)} in`;
  const printSizeMeta = `${Math.round(printMm)} mm @300dpi · PNG ${exportScale}x`;

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      theme === "dark" ? "dark" : "light"
    );
    window.localStorage.setItem("bamsense-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (shareAppliedRef.current) {
      return;
    }
    const shared = readShareFromLocation();
    if (!shared) {
      return;
    }
    shareAppliedRef.current = true;
    setTemplate(shared.template || "plain");
    setTextInput(shared.textInput ?? "");
    setTemplateData({
      ...DEFAULT_TEMPLATE_DATA,
      ...(shared.templateData || {})
    });
    setSize(clampNumber(Number(shared.size) || 280, 160, 512));
    setMargin(clampNumber(Number(shared.margin) || 2, 0, 8));
    setErrorCorrection(shared.errorCorrection || "M");
    setFgColor(shared.fgColor || "#274c6f");
    setBgColor(shared.bgColor || "#ffffff");
    setTransparentBg(Boolean(shared.transparentBg));
    setLogoScale(clampNumber(Number(shared.logoScale) || 0.22, 0.12, 0.35));
    setLogoSafeArea(shared.logoSafeArea !== false);
    setExportScale(
      clampNumber(Number(shared.exportScale) || 1, 1, 4)
    );
    setShareUrl("");
    setPresetName("");
  }, []);

  useEffect(() => {
    return () => {
      if (statusTimeoutRef.current) {
        window.clearTimeout(statusTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!bulkColumns.length) {
      return;
    }
    const nextMap = autoMapColumns(template, bulkColumns);
    setBulkMap(nextMap);
    setBulkFilenameColumn((prev) => prev || autoPickFilename(bulkColumns));
  }, [template, bulkColumns]);

  useEffect(() => {
    const value = deferredPayload.trim();
    if (!value) {
      setQrDataUrl("");
      setQrSvg("");
      setStatus("Type something to generate a QR code.");
      return;
    }

    let cancelled = false;
    setStatus("Generating...");

    const options = {
      width: size,
      margin,
      errorCorrectionLevel: errorCorrection,
      color: {
        dark: fgColor,
        light: effectiveBgColor
      }
    };

    Promise.all([
      QRCode.toDataURL(value, options),
      QRCode.toString(value, { ...options, type: "svg" })
    ])
      .then(async ([dataUrl, svg]) => {
        if (cancelled) {
          return;
        }
        let finalDataUrl = dataUrl;
        if (logoDataUrl) {
          try {
            finalDataUrl = await applyLogoOverlay(
              dataUrl,
              logoDataUrl,
              size,
              logoScale,
              logoSafeArea
            );
          } catch {
            finalDataUrl = dataUrl;
          }
        }
        if (cancelled) {
          return;
        }
        setQrDataUrl(finalDataUrl);
        setQrSvg(svg);
        setStatus("Ready");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setQrDataUrl("");
        setQrSvg("");
        setStatus("Unable to generate QR code. Check your input.");
      });

    return () => {
      cancelled = true;
    };
  }, [
    deferredPayload,
    size,
    margin,
    errorCorrection,
    fgColor,
    bgColor,
    transparentBg,
    logoDataUrl,
    logoScale,
    logoSafeArea
  ]);

  useEffect(() => {
    const value = deferredPayload.trim();
    if (!value) {
      setQrStats(null);
      return;
    }
    try {
      const qr = QRCode.create(value, {
        errorCorrectionLevel: errorCorrection
      });
      const modules = qr?.modules?.size ?? 0;
      const modulePx = modules ? size / (modules + margin * 2) : 0;
      const bytes = new TextEncoder().encode(value).length;
      setQrStats({
        version: qr.version,
        modules,
        maskPattern: qr.maskPattern,
        modulePx,
        bytes,
        chars: value.length
      });
    } catch {
      setQrStats(null);
    }
  }, [deferredPayload, errorCorrection, margin, size]);

  const flashStatus = (message) => {
    setStatus(message);
    if (statusTimeoutRef.current) {
      window.clearTimeout(statusTimeoutRef.current);
    }
    statusTimeoutRef.current = window.setTimeout(() => {
      setStatus((prev) => (prev === message ? "Ready" : prev));
    }, 1500);
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    } catch {
      flashStatus("Preset storage full.");
    }
  }, [presets]);

  useEffect(() => {
    setShareUrl("");
  }, [
    template,
    textInput,
    templateData,
    size,
    margin,
    errorCorrection,
    fgColor,
    bgColor,
    transparentBg,
    logoScale,
    logoSafeArea,
    exportScale,
    shareIncludePayload
  ]);

  const buildShareLink = () => {
    if (typeof window === "undefined") {
      return "";
    }
    const sharePayload = {
      template,
      textInput: shareIncludePayload ? textInput : "",
      templateData: shareIncludePayload ? templateData : DEFAULT_TEMPLATE_DATA,
      size,
      margin,
      errorCorrection,
      fgColor,
      bgColor,
      transparentBg,
      logoScale,
      logoSafeArea,
      exportScale
    };
    const encoded = encodeSharePayload(sharePayload);
    if (!encoded) {
      return "";
    }
    return `${window.location.origin}${window.location.pathname}#${SHARE_PARAM}=${encoded}`;
  };

  const generateShareLink = () => {
    const next = buildShareLink();
    if (!next) {
      flashStatus("Unable to create share link.");
      return;
    }
    setShareUrl(next);
    flashStatus("Share link ready.");
  };

  const copyShareLink = async () => {
    const link = shareUrl || buildShareLink();
    if (!link) {
      flashStatus("Unable to create share link.");
      return;
    }
    setShareUrl(link);
    await copyToClipboard(link);
    flashStatus("Share link copied.");
  };

  const buildExportPng = async () => {
    const value = payload.trim();
    if (!value) {
      return "";
    }
    const scaledSize = Math.round(size * exportScale);
    const options = {
      width: scaledSize,
      margin,
      errorCorrectionLevel: errorCorrection,
      color: {
        dark: fgColor,
        light: effectiveBgColor
      }
    };
    const dataUrl = await QRCode.toDataURL(value, options);
    if (!logoDataUrl) {
      return dataUrl;
    }
    return applyLogoOverlay(
      dataUrl,
      logoDataUrl,
      scaledSize,
      logoScale,
      logoSafeArea
    );
  };

  const copyPngToClipboard = async () => {
    if (!payload.trim()) {
      return;
    }
    if (!navigator.clipboard || !window.ClipboardItem) {
      flashStatus("Clipboard not available.");
      return;
    }
    try {
      const dataUrl = exportScale === 1 ? qrDataUrl : await buildExportPng();
      if (!dataUrl) {
        flashStatus("Copy failed.");
        return;
      }
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new window.ClipboardItem({ "image/png": blob })
      ]);
      flashStatus("Copied PNG.");
    } catch (error) {
      flashStatus("Copy failed.");
    }
  };

  const copySvgToClipboard = async () => {
    if (!qrSvg) {
      return;
    }
    if (!navigator.clipboard) {
      flashStatus("Clipboard not available.");
      return;
    }
    try {
      await navigator.clipboard.writeText(qrSvg);
      flashStatus("Copied SVG.");
    } catch (error) {
      flashStatus("Copy failed.");
    }
  };

  const downloadPng = () => {
    if (!payload.trim()) {
      return;
    }
    buildExportPng()
      .then((dataUrl) => {
        if (!dataUrl) {
          return;
        }
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = "bamsense-qr.png";
        link.click();
        pushHistory(
          createHistoryEntry({
            type: "png",
            payload: payload.trim(),
            template,
            size: Math.round(size * exportScale),
            margin,
            errorCorrection,
            fgColor,
            bgColor,
            dataUrl
          })
        );
      })
      .catch(() => flashStatus("Download failed."));
  };

  const downloadSvg = () => {
    if (!qrSvg) {
      return;
    }
    const blob = new Blob([qrSvg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "bamsense-qr.svg";
    link.click();
    URL.revokeObjectURL(url);
    pushHistory(
      createHistoryEntry({
        type: "svg",
        payload: payload.trim(),
        template,
        size,
        margin,
        errorCorrection,
        fgColor,
        bgColor,
        svg: qrSvg
      })
    );
  };

  const templateLabel = getTemplateLabel(template);

  const infoChips = [
    `Template: ${templateLabel}`,
    `Size: ${size}px`,
    `Margin: ${margin}`,
    `EC: ${errorCorrection}`,
    `BG: ${transparentBg ? "transparent" : bgColor}`,
    logoDataUrl ? `Logo: ${Math.round(logoScale * 100)}%` : null
  ].filter(Boolean);

  const onSizeChange = (event) => {
    const value = Number(event.target.value);
    setSize(clampNumber(value, 160, 512));
  };

  const onMarginChange = (event) => {
    const value = Number(event.target.value);
    setMargin(clampNumber(value, 0, 8));
  };

  const onLogoScaleChange = (event) => {
    const value = Number(event.target.value);
    setLogoScale(clampNumber(value, 0.12, 0.35));
  };

  const onTemplateChange = (event) => {
    setTemplate(event.target.value);
  };

  const updateTemplateField = (field) => (event) => {
    const value =
      event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setTemplateData((prev) => ({ ...prev, [field]: value }));
  };

  const updateBulkMap = (field) => (event) => {
    setBulkMap((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const pushHistory = (entry) => {
    setHistory((prev) => {
      const next = [entry, ...prev];
      return next.slice(0, HISTORY_LIMIT);
    });
  };

  const clearHistory = () => {
    setHistory([]);
  };

  const copyToClipboard = async (value) => {
    if (!value) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {
      // fallback below
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {
      // ignore copy failure
    }
    document.body.removeChild(textarea);
  };

  const downloadHistoryItem = (entry) => {
    if (!entry) {
      return;
    }
    if (entry.type === "png" && entry.dataUrl) {
      const link = document.createElement("a");
      link.href = entry.dataUrl;
      link.download = "bamsense-qr.png";
      link.click();
      return;
    }
    if (entry.type === "svg" && entry.svg) {
      const blob = new Blob([entry.svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "bamsense-qr.svg";
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  const parseCsvText = (text) => {
    const result = Papa.parse(text, {
      header: true,
      skipEmptyLines: true
    });

    if (result.errors?.length) {
      setBulkStatus("CSV parsing error. Check your headers and rows.");
      return;
    }

    const fields = result.meta?.fields ?? [];
    const rows = (result.data || []).filter((row) =>
      Object.values(row || {}).some((value) => String(value || "").trim())
    );

    if (!fields.length) {
      setBulkColumns([]);
      setBulkRows([]);
      setBulkStatus("CSV must include a header row.");
      return;
    }

    setBulkColumns(fields);
    setBulkRows(rows);
    setBulkStatus(
      rows.length ? `${rows.length} rows loaded.` : "No rows found in CSV."
    );
  };

  const handleCsvUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setBulkStatus("Parsing CSV...");
    file
      .text()
      .then((text) => parseCsvText(text))
      .catch(() => setBulkStatus("Unable to read CSV file."));
  };

  const clearBulk = () => {
    setBulkRows([]);
    setBulkColumns([]);
    setBulkMap({});
    setBulkFilenameColumn("");
    setBulkStatus("Upload a CSV to generate in bulk.");
  };

  const clearTemplateFields = (activeTemplate) => {
    const fields = TEMPLATE_FIELD_KEYS[activeTemplate];
    if (!fields) {
      return;
    }
    setTemplateData((prev) => {
      const next = { ...prev };
      fields.forEach((field) => {
        next[field] = DEFAULT_TEMPLATE_DATA[field];
      });
      return next;
    });
  };

  const handleClear = () => {
    if (template === "plain") {
      setTextInput("");
      return;
    }
    clearTemplateFields(template);
  };

  const handleLogoUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      flashStatus("Upload a PNG or JPG logo.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setLogoDataUrl(reader.result);
        setLogoName(file.name);
      } else {
        flashStatus("Unable to read logo.");
      }
    };
    reader.onerror = () => flashStatus("Unable to read logo.");
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const clearLogo = () => {
    setLogoDataUrl("");
    setLogoName("");
  };

  const savePreset = () => {
    const name = presetName.trim() || `Preset ${presets.length + 1}`;
    const createdAt = Date.now();
    const id = `${createdAt}-${Math.random().toString(36).slice(2, 6)}`;
    const nextPreset = {
      id,
      name,
      createdAt,
      template,
      textInput,
      templateData,
      size,
      margin,
      errorCorrection,
      fgColor,
      bgColor,
      transparentBg,
      logoDataUrl,
      logoName,
      logoScale,
      logoSafeArea,
      exportScale
    };
    setPresets((prev) => [nextPreset, ...prev].slice(0, PRESET_LIMIT));
    setPresetName("");
    flashStatus("Preset saved.");
  };

  const applyPreset = (preset) => {
    if (!preset) {
      return;
    }
    setTemplate(preset.template || "plain");
    setTextInput(preset.textInput ?? DEFAULT_TEXT);
    setTemplateData({
      ...DEFAULT_TEMPLATE_DATA,
      ...(preset.templateData || {})
    });
    setSize(clampNumber(Number(preset.size) || 280, 160, 512));
    setMargin(clampNumber(Number(preset.margin) || 2, 0, 8));
    setErrorCorrection(preset.errorCorrection || "M");
    setFgColor(preset.fgColor || "#274c6f");
    setBgColor(preset.bgColor || "#ffffff");
    setTransparentBg(Boolean(preset.transparentBg));
    setLogoDataUrl(preset.logoDataUrl || "");
    setLogoName(preset.logoName || "");
    setLogoScale(clampNumber(Number(preset.logoScale) || 0.22, 0.12, 0.35));
    setLogoSafeArea(preset.logoSafeArea !== false);
    setExportScale(clampNumber(Number(preset.exportScale) || 1, 1, 4));
    flashStatus("Preset applied.");
  };

  const removePreset = (id) => {
    setPresets((prev) => prev.filter((preset) => preset.id !== id));
  };

  const clearPresets = () => {
    setPresets([]);
  };

  const exportPresets = () => {
    if (!presets.length) {
      flashStatus("No presets to export.");
      return;
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      presets
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `bamsense-qr-presets-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    flashStatus("Presets exported.");
  };

  const normalizePreset = (preset, index) => {
    if (!preset || typeof preset !== "object") {
      return null;
    }
    const createdAt = Number(preset.createdAt) || Date.now() - index;
    const id = preset.id || `${createdAt}-${Math.random().toString(36).slice(2, 6)}`;
    const templateValue = TEMPLATE_OPTIONS.some(
      (option) => option.value === preset.template
    )
      ? preset.template
      : "plain";
    const errorValue = ERROR_LEVELS.some(
      (level) => level.value === preset.errorCorrection
    )
      ? preset.errorCorrection
      : "M";
    return {
      id,
      name: String(preset.name || `Imported ${index + 1}`),
      createdAt,
      template: templateValue,
      textInput: preset.textInput ?? DEFAULT_TEXT,
      templateData: {
        ...DEFAULT_TEMPLATE_DATA,
        ...(preset.templateData || {})
      },
      size: clampNumber(Number(preset.size) || 280, 160, 512),
      margin: clampNumber(Number(preset.margin) || 2, 0, 8),
      errorCorrection: errorValue,
      fgColor: preset.fgColor || "#274c6f",
      bgColor: preset.bgColor || "#ffffff",
      transparentBg: Boolean(preset.transparentBg),
      logoDataUrl: preset.logoDataUrl || "",
      logoName: preset.logoName || "",
      logoScale: clampNumber(Number(preset.logoScale) || 0.22, 0.12, 0.35),
      logoSafeArea: preset.logoSafeArea !== false,
      exportScale: clampNumber(Number(preset.exportScale) || 1, 1, 4)
    };
  };

  const importPresets = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    file
      .text()
      .then((raw) => {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : parsed?.presets;
        if (!Array.isArray(list) || list.length === 0) {
          flashStatus("No presets found in that file.");
          return;
        }
        const normalized = list
          .map((preset, index) => normalizePreset(preset, index))
          .filter(Boolean);
        if (!normalized.length) {
          flashStatus("No valid presets found.");
          return;
        }
        setPresets((prev) =>
          [...normalized, ...prev].slice(0, PRESET_LIMIT)
        );
        flashStatus(`Imported ${normalized.length} preset${normalized.length > 1 ? "s" : ""}.`);
      })
      .catch(() => {
        flashStatus("Unable to import presets.");
      });
    event.target.value = "";
  };

  const triggerPresetImport = () => {
    presetFileInputRef.current?.click();
  };

  const bulkFields = BULK_FIELDS[template] ?? BULK_FIELDS.plain;
  const missingBulkFields = bulkFields
    .filter((field) => field.required)
    .filter((field) => !bulkMap[field.key])
    .map((field) => field.label.replace(" column", ""));

  const handleBulkGenerate = async () => {
    if (!bulkRows.length || bulkIsGenerating) {
      return;
    }
    if (missingBulkFields.length) {
      setBulkStatus(
        `Select required columns: ${missingBulkFields.join(", ")}.`
      );
      return;
    }

    const limitNotice = bulkRows.length > BULK_MAX_ROWS;
    const rows = bulkRows.slice(0, BULK_MAX_ROWS);
    const zip = new JSZip();
    let generated = 0;
    let skipped = 0;

    setBulkIsGenerating(true);
    setBulkStatus(`Generating 0/${rows.length}...`);

    const options = {
      width: size,
      margin,
      errorCorrectionLevel: errorCorrection,
      color: {
        dark: fgColor,
        light: effectiveBgColor
      }
    };

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const payloadText = buildPayloadFromRow(template, row, bulkMap).trim();
      if (!payloadText) {
        skipped += 1;
        continue;
      }

      try {
        const dataUrl = await QRCode.toDataURL(payloadText, options);
        const finalDataUrl = logoDataUrl
          ? await applyLogoOverlay(
              dataUrl,
              logoDataUrl,
              size,
              logoScale,
              logoSafeArea
            )
          : dataUrl;
        const base64 = finalDataUrl.split(",")[1];
        const fileBase = bulkFilenameColumn
          ? getRowValue(row, bulkFilenameColumn)
          : "";
        const safeName = sanitizeFileName(
          fileBase || `qr-${String(index + 1).padStart(3, "0")}`
        );
        zip.file(`${safeName}.png`, base64, { base64: true });
        generated += 1;
      } catch {
        skipped += 1;
      }

      setBulkStatus(`Generating ${index + 1}/${rows.length}...`);
    }

    if (!generated) {
      setBulkStatus("No QR codes generated. Check your mapping.");
      setBulkIsGenerating(false);
      return;
    }

    try {
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "bamsense-qr-bulk.zip";
      link.click();
      URL.revokeObjectURL(url);
      pushHistory(
        createHistoryEntry({
          type: "zip",
          template,
          generated,
          skipped,
          limited: limitNotice
        })
      );
    } catch {
      setBulkStatus("Unable to build ZIP. Try fewer rows.");
      setBulkIsGenerating(false);
      return;
    }

    let summary = `Done. ${generated} QR codes exported`;
    if (skipped) {
      summary += `, ${skipped} skipped`;
    }
    if (limitNotice) {
      summary += `. Limited to ${BULK_MAX_ROWS} rows.`;
    } else {
      summary += ".";
    }
    setBulkStatus(summary);
    setBulkIsGenerating(false);
  };

  return (
    <div className="app">
      <div className="bg-orb orb-1" />
      <div className="bg-orb orb-2" />
      <div className="bg-orb orb-3" />

      <header className="topbar container">
        <div className="brand">
          <div className="brand-mark">QR</div>
          <div className="brand-title">
            <span>Bamsense QR</span>
            <small>Open-source. Local. Private.</small>
          </div>
        </div>
      </header>

      <main className="container">
        <section className="privacy-banner">
          <div className="privacy-left">
            <div className="privacy-icon" aria-hidden="true">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </div>
            <div className="privacy-text">
              <p className="privacy-title">Your files stay private</p>
              <p className="privacy-subtitle">
                Processing happens 100% in your browser. No uploads.
              </p>
            </div>
          </div>
          <div className="privacy-tags">
            <span className="tag">Local only</span>
            <a
              className="tag tag-link"
              href="https://github.com/bamsense-works/qrcode/tree/main?tab=MIT-1-ov-file"
              target="_blank"
              rel="noreferrer"
            >
              Open source
            </a>
            <button
              className="tag theme-chip"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              type="button"
            >
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
          </div>
        </section>

        <section className="workspace">
          <div className="card">
            <div className="panel-header">
              <h2>Content</h2>
              <span className="badge">Local only</span>
            </div>

            <label className="field">
              <span>Template</span>
              <select
                className="select"
                value={template}
                onChange={onTemplateChange}
              >
                {TEMPLATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {template !== "plain" && (
              <div className="template-fields">
                {template === "url" && (
                  <div className="options-grid compact">
                    <label className="field">
                      <span>URL</span>
                      <input
                        className="input"
                        type="url"
                        placeholder="https://example.com"
                        value={templateData.url}
                        onChange={updateTemplateField("url")}
                      />
                    </label>
                  </div>
                )}

                {template === "wifi" && (
                  <div className="options-grid compact">
                    <label className="field">
                      <span>Network name (SSID)</span>
                      <input
                        className="input"
                        placeholder="Office WiFi"
                        value={templateData.wifiSsid}
                        onChange={updateTemplateField("wifiSsid")}
                      />
                    </label>
                    <label className="field">
                      <span>Password</span>
                      <input
                        className="input"
                        type="password"
                        placeholder="WiFi password"
                        value={templateData.wifiPassword}
                        onChange={updateTemplateField("wifiPassword")}
                      />
                    </label>
                    <label className="field">
                      <span>Encryption</span>
                      <select
                        className="select"
                        value={templateData.wifiType}
                        onChange={updateTemplateField("wifiType")}
                      >
                        <option value="WPA">WPA/WPA2</option>
                        <option value="WEP">WEP</option>
                        <option value="nopass">No password</option>
                      </select>
                    </label>
                    <label className="field checkbox-row">
                      <input
                        type="checkbox"
                        checked={templateData.wifiHidden}
                        onChange={updateTemplateField("wifiHidden")}
                      />
                      <span>Hidden network</span>
                    </label>
                  </div>
                )}

                {template === "email" && (
                  <div className="options-grid compact">
                    <label className="field">
                      <span>To</span>
                      <input
                        className="input"
                        type="email"
                        placeholder="hello@example.com"
                        value={templateData.emailTo}
                        onChange={updateTemplateField("emailTo")}
                      />
                    </label>
                    <label className="field">
                      <span>Subject</span>
                      <input
                        className="input"
                        placeholder="Subject line"
                        value={templateData.emailSubject}
                        onChange={updateTemplateField("emailSubject")}
                      />
                    </label>
                    <label className="field field-wide">
                      <span>Message</span>
                      <textarea
                        className="textarea"
                        placeholder="Email body"
                        value={templateData.emailBody}
                        onChange={updateTemplateField("emailBody")}
                      />
                    </label>
                  </div>
                )}

                {template === "sms" && (
                  <div className="options-grid compact">
                    <label className="field">
                      <span>Phone number</span>
                      <input
                        className="input"
                        placeholder="+1 555 012 3456"
                        value={templateData.smsTo}
                        onChange={updateTemplateField("smsTo")}
                      />
                    </label>
                    <label className="field field-wide">
                      <span>Message</span>
                      <textarea
                        className="textarea"
                        placeholder="SMS message"
                        value={templateData.smsBody}
                        onChange={updateTemplateField("smsBody")}
                      />
                    </label>
                  </div>
                )}

                {template === "vcard" && (
                  <div className="options-grid compact">
                    <label className="field">
                      <span>Full name</span>
                      <input
                        className="input"
                        placeholder="Alex Rao"
                        value={templateData.vName}
                        onChange={updateTemplateField("vName")}
                      />
                    </label>
                    <label className="field">
                      <span>Organization</span>
                      <input
                        className="input"
                        placeholder="Bamsense Works"
                        value={templateData.vOrg}
                        onChange={updateTemplateField("vOrg")}
                      />
                    </label>
                    <label className="field">
                      <span>Title</span>
                      <input
                        className="input"
                        placeholder="Founder"
                        value={templateData.vTitle}
                        onChange={updateTemplateField("vTitle")}
                      />
                    </label>
                    <label className="field">
                      <span>Phone</span>
                      <input
                        className="input"
                        placeholder="+1 555 012 3456"
                        value={templateData.vPhone}
                        onChange={updateTemplateField("vPhone")}
                      />
                    </label>
                    <label className="field">
                      <span>Email</span>
                      <input
                        className="input"
                        type="email"
                        placeholder="alex@bamsense.works"
                        value={templateData.vEmail}
                        onChange={updateTemplateField("vEmail")}
                      />
                    </label>
                    <label className="field">
                      <span>Website</span>
                      <input
                        className="input"
                        placeholder="https://bamsense.works"
                        value={templateData.vUrl}
                        onChange={updateTemplateField("vUrl")}
                      />
                    </label>
                    <label className="field field-wide">
                      <span>Address</span>
                      <input
                        className="input"
                        placeholder="Street, City, Country"
                        value={templateData.vAddress}
                        onChange={updateTemplateField("vAddress")}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            <label className="field">
              <span>Text or payload</span>
              <textarea
                className="textarea"
                placeholder={
                  template === "plain"
                    ? "Paste a URL, text, or any QR payload"
                    : "Generated from your template fields"
                }
                value={template === "plain" ? textInput : payload}
                onChange={
                  template === "plain"
                    ? (event) => setTextInput(event.target.value)
                    : undefined
                }
                readOnly={template !== "plain"}
              />
              {template !== "plain" && (
                <span className="field-help">
                  Payload is generated automatically from your template fields.
                </span>
              )}
            </label>

            <div className="options-grid compact">
              <label className="field">
                <span>Size (px)</span>
                <input
                  className="range"
                  type="range"
                  min="160"
                  max="512"
                  value={size}
                  onChange={onSizeChange}
                />
              </label>

              <label className="field">
                <span>Margin</span>
                <input
                  className="range"
                  type="range"
                  min="0"
                  max="8"
                  value={margin}
                  onChange={onMarginChange}
                />
              </label>
            </div>

            <details className="advanced">
              <summary>More options</summary>
              <div className="options-grid">
                <label className="field">
                  <span>Error Correction</span>
                  <select
                    className="select"
                    value={errorCorrection}
                    onChange={(event) => setErrorCorrection(event.target.value)}
                  >
                    {ERROR_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>
                        {level.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="field">
                  <span>Foreground</span>
                  <div className="color-row">
                    <div className="color-swatch">
                      <input
                        type="color"
                        value={fgColor}
                        onChange={(event) => setFgColor(event.target.value)}
                        aria-label="Foreground color"
                      />
                    </div>
                    <input
                      className="input mono"
                      value={fgColor}
                      onChange={(event) => setFgColor(event.target.value)}
                    />
                  </div>
                </div>

                <div className="field">
                  <span>Background</span>
                  <div className="color-row">
                    <div className="color-swatch">
                      <input
                        type="color"
                        value={bgColor}
                        onChange={(event) => setBgColor(event.target.value)}
                        aria-label="Background color"
                        disabled={transparentBg}
                      />
                    </div>
                    <input
                      className="input mono"
                      value={bgColor}
                      onChange={(event) => setBgColor(event.target.value)}
                      disabled={transparentBg}
                    />
                  </div>
                  {transparentBg && (
                    <span className="field-help">
                      Transparent background ignores this color.
                    </span>
                  )}
                </div>

                <label className="field checkbox-row">
                  <input
                    type="checkbox"
                    checked={transparentBg}
                    onChange={(event) => setTransparentBg(event.target.checked)}
                  />
                  <span>Transparent background</span>
                </label>

                <div className="contrast-callout">
                  <div>
                    <strong>Contrast {contrastRatioLabel}</strong>
                    <div>
                      {contrastMessage}
                      {transparentBg ? " Assumes white background." : ""}
                    </div>
                  </div>
                  <span className={contrastBadgeClass}>{contrastLabel}</span>
                </div>

                <label className="field">
                  <span>PNG export scale</span>
                  <select
                    className="select"
                    value={exportScale}
                    onChange={(event) =>
                      setExportScale(clampNumber(Number(event.target.value) || 1, 1, 4))
                    }
                  >
                    <option value={1}>1x (default)</option>
                    <option value={2}>2x</option>
                    <option value={3}>3x</option>
                    <option value={4}>4x</option>
                  </select>
                  <span className="field-help">
                    Applies to PNG downloads and clipboard copies.
                  </span>
                </label>

                <div className="field field-wide">
                  <span>Logo overlay</span>
                  <div className="logo-panel">
                    <div className="logo-row">
                      <input
                        className="input file-input"
                        type="file"
                        accept="image/png,image/jpeg"
                        onChange={handleLogoUpload}
                      />
                      <button
                        className="btn btn-ghost btn-small"
                        type="button"
                        onClick={clearLogo}
                        disabled={!logoDataUrl}
                      >
                        Clear logo
                      </button>
                    </div>
                    <div className="logo-meta">
                      {logoDataUrl
                        ? `Using ${logoName || "custom logo"}.`
                        : "Upload a square PNG/JPG. We'll center it automatically."}
                    </div>
                    <div className="options-grid compact">
                      <label className="field">
                        <span>Logo size</span>
                        <input
                          className="range"
                          type="range"
                          min="0.12"
                          max="0.35"
                          step="0.01"
                          value={logoScale}
                          onChange={onLogoScaleChange}
                        />
                        <span className="field-help">
                          {Math.round(logoScale * 100)}% of QR size
                        </span>
                      </label>
                      <label className="field checkbox-row">
                        <input
                          type="checkbox"
                          checked={logoSafeArea}
                          onChange={(event) => setLogoSafeArea(event.target.checked)}
                        />
                        <span>White safe area</span>
                      </label>
                    </div>
                    {logoDataUrl && errorCorrection !== "H" && (
                      <div className="logo-note">
                        Tip: set error correction to High for best scan reliability.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </details>

            <details className="preset-panel">
              <summary>Presets</summary>
              <div className="preset-body">
                <div className="preset-row">
                  <input
                    className="input"
                    placeholder="Preset name"
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                  <button
                    className="btn btn-primary btn-small"
                    type="button"
                    onClick={savePreset}
                  >
                    Save preset
                  </button>
                </div>
                <div className="preset-tools">
                  <button
                    className="btn btn-ghost btn-small"
                    type="button"
                    onClick={exportPresets}
                    disabled={!presets.length}
                  >
                    Export presets
                  </button>
                  <button
                    className="btn btn-ghost btn-small"
                    type="button"
                    onClick={triggerPresetImport}
                  >
                    Import presets
                  </button>
                  <input
                    ref={presetFileInputRef}
                    className="preset-file"
                    type="file"
                    accept="application/json"
                    onChange={importPresets}
                  />
                </div>
                {presets.length === 0 && (
                  <div className="preset-empty">
                    No presets yet. Save your favorite settings here.
                  </div>
                )}
                {presets.length > 0 && (
                  <div className="preset-list">
                    {presets.map((preset) => (
                      <div className="preset-item" key={preset.id}>
                        <div className="preset-info">
                          <div className="preset-name">{preset.name}</div>
                          <div className="preset-meta">
                            {getTemplateLabel(preset.template)} · {preset.size || 280}
                            px · EC {preset.errorCorrection || "M"}
                          </div>
                        </div>
                        <div className="preset-actions">
                          <button
                            className="btn btn-ghost btn-small"
                            type="button"
                            onClick={() => applyPreset(preset)}
                          >
                            Apply
                          </button>
                          <button
                            className="btn btn-ghost btn-small"
                            type="button"
                            onClick={() => removePreset(preset.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      className="btn btn-ghost btn-small"
                      type="button"
                      onClick={clearPresets}
                    >
                      Clear presets
                    </button>
                  </div>
                )}
              </div>
            </details>

            <details className="share-panel">
              <summary>Shareable link</summary>
              <div className="share-body">
                <p className="share-note">
                  Create a link that restores your current settings. Data stays in
                  the URL hash and never hits a server.
                </p>
                <label className="field checkbox-row">
                  <input
                    type="checkbox"
                    checked={shareIncludePayload}
                    onChange={(event) => setShareIncludePayload(event.target.checked)}
                  />
                  <span>Include payload data</span>
                </label>
                <div className="share-row">
                  <button
                    className="btn btn-ghost btn-small"
                    type="button"
                    onClick={generateShareLink}
                  >
                    Generate link
                  </button>
                  <button
                    className="btn btn-primary btn-small"
                    type="button"
                    onClick={copyShareLink}
                  >
                    Copy link
                  </button>
                </div>
                <input
                  className="input mono"
                  value={shareUrl}
                  placeholder="Share link appears here"
                  readOnly
                />
                <div className="share-meta">
                  Logo overlays are not included to keep links short.
                </div>
              </div>
            </details>

            <details className="bulk-panel">
              <summary>Bulk QR (CSV)</summary>
              <div className="bulk-body">
                <p className="bulk-note">
                  Upload a CSV with headers. Bulk generation uses the current
                  template: <strong>{templateLabel}</strong>. Up to{" "}
                  {BULK_MAX_ROWS} rows per export.
                </p>
                <div className="bulk-row">
                  <input
                    className="input file-input"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={handleCsvUpload}
                  />
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={clearBulk}
                    disabled={!bulkRows.length && !bulkColumns.length}
                  >
                    Clear CSV
                  </button>
                </div>
                <div className="bulk-status">{bulkStatus}</div>

                {bulkColumns.length > 0 && (
                  <div className="options-grid compact">
                    {bulkFields.map((field) => (
                      <label key={field.key} className="field">
                        <span>
                          {field.label}
                          {field.required ? " *" : ""}
                        </span>
                        <select
                          className="select"
                          value={bulkMap[field.key] || ""}
                          onChange={updateBulkMap(field.key)}
                        >
                          <option value="">Select column</option>
                          {bulkColumns.map((column) => (
                            <option key={column} value={column}>
                              {column}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                )}

                {bulkColumns.length > 0 && (
                  <label className="field">
                    <span>Filename column (optional)</span>
                    <select
                      className="select"
                      value={bulkFilenameColumn}
                      onChange={(event) => setBulkFilenameColumn(event.target.value)}
                    >
                      <option value="">Use row number</option>
                      {bulkColumns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <div className="actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={handleBulkGenerate}
                    disabled={
                      !bulkRows.length ||
                      bulkIsGenerating ||
                      missingBulkFields.length > 0
                    }
                  >
                    Download ZIP
                  </button>
                </div>
              </div>
            </details>

            <div className="actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={downloadPng}
                disabled={!qrDataUrl}
              >
                Download PNG
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={downloadSvg}
                disabled={!qrSvg}
              >
                Download SVG
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={handleClear}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="card preview">
            <div className="preview-header">
              <h2>Preview</h2>
              <div className="preview-actions">
                <button
                  className="btn btn-ghost btn-small"
                  type="button"
                  onClick={copySvgToClipboard}
                  disabled={!qrSvg}
                >
                  Copy SVG
                </button>
                <button
                  className="btn btn-ghost btn-small"
                  type="button"
                  onClick={copyPngToClipboard}
                  disabled={!qrDataUrl}
                >
                  Copy PNG
                </button>
                <span className="badge">{status}</span>
              </div>
            </div>
            <div className="preview-body">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Generated QR code preview"
                  className="qr-preview"
                />
              ) : (
                <div className="placeholder">
                  Start typing to preview your QR code here.
                </div>
              )}
            </div>
            <div className="scan-diagnostics">
              <div className="diagnostic-header">
                <div>
                  <strong>Scan diagnostics</strong>
                  <div className="diagnostic-sub">{moduleMessage}</div>
                </div>
                <span className={moduleBadgeClass}>{moduleBadgeLabel}</span>
              </div>
              <div className="diagnostic-banner">
                <div>
                  <strong>Payload {bytesLabel}</strong>
                  <div>{payloadMessage}</div>
                </div>
                <span className={payloadBadgeClass}>{payloadLabel}</span>
              </div>
              <div className="diagnostic-grid">
                <div className="diagnostic-item">
                  <span>Module size</span>
                  <strong>{modulePxLabel}</strong>
                </div>
                <div className="diagnostic-item">
                  <span>Grid</span>
                  <strong>{moduleGridLabel}</strong>
                </div>
                <div className="diagnostic-item">
                  <span>Version</span>
                  <strong>{versionLabel}</strong>
                </div>
                <div className="diagnostic-item">
                  <span>Mask</span>
                  <strong>{maskLabel}</strong>
                </div>
                <div className="diagnostic-item">
                  <span>Min size</span>
                  <strong>{minSizeLabel}</strong>
                  {idealSizeLabel ? <em>{idealSizeLabel}</em> : null}
                </div>
                <div className="diagnostic-item">
                  <span>Print size</span>
                  <strong>{printSizeLabel}</strong>
                  <em>{printSizeMeta}</em>
                </div>
                <div className="diagnostic-item">
                  <span>Quiet zone</span>
                  <strong>{`Margin ${margin} modules`}</strong>
                  <em>
                    {quietZoneMessage} <span className={quietZoneBadgeClass}>{quietZoneLabel}</span>
                  </em>
                </div>
              </div>
            </div>
            <div className="chip-row">
              {infoChips.map((chip) => (
                <span key={chip} className="chip">
                  {chip}
                </span>
              ))}
            </div>

            <details className="history-panel">
              <summary>
                <span>Recent exports</span>
                <span className="history-count">{history.length}</span>
              </summary>
              <div className="history-body">
                {history.length === 0 && (
                  <div className="history-empty">
                    No exports yet. Download PNG or SVG to add items here.
                  </div>
                )}
                {history.map((entry) => {
                  const timestamp = new Date(entry.createdAt).toLocaleString();
                  const templateName = getTemplateLabel(entry.template);
                  const meta =
                    entry.type === "zip"
                      ? `${
                          entry.generated || 0
                        } generated${entry.skipped ? `, ${entry.skipped} skipped` : ""}${
                          entry.limited ? `, limited to ${BULK_MAX_ROWS}` : ""
                        } · ${templateName} · ${timestamp}`
                      : `${entry.type.toUpperCase()} · ${templateName} · ${
                          entry.size
                        }px · EC ${entry.errorCorrection} · ${timestamp}`;
                  return (
                    <div className="history-item" key={entry.id}>
                      <div className="history-info">
                        <div className="history-title">
                          {entry.type === "zip"
                            ? "Bulk ZIP export"
                            : formatPayloadSnippet(entry.payload)}
                        </div>
                        <div className="history-meta">{meta}</div>
                      </div>
                      <div className="history-actions">
                        {entry.type !== "zip" && (
                          <>
                            <button
                              className="btn btn-ghost btn-small"
                              type="button"
                              onClick={() => copyToClipboard(entry.payload)}
                            >
                              Copy payload
                            </button>
                            <button
                              className="btn btn-primary btn-small"
                              type="button"
                              onClick={() => downloadHistoryItem(entry)}
                            >
                              Download
                            </button>
                          </>
                        )}
                        {entry.type === "zip" && (
                          <span className="history-tag">ZIP</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {history.length > 0 && (
                  <button
                    className="btn btn-ghost btn-small"
                    type="button"
                    onClick={clearHistory}
                  >
                    Clear history
                  </button>
                )}
              </div>
            </details>
          </div>
        </section>

      </main>

      <footer className="container footer">
        <div>
          <strong>Bamsense Works</strong> · Open-source QR tools for modern
          teams.
        </div>
        <a
          className="mono footer-link"
          href="https://github.com/bamsense-works/qrcode/tree/main?tab=MIT-1-ov-file"
          target="_blank"
          rel="noreferrer"
        >
          MIT License · v0.1.0
        </a>
      </footer>
    </div>
  );
}
