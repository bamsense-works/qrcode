import { useEffect, useState, useDeferredValue } from "react";
import QRCode from "qrcode";

const ERROR_LEVELS = [
  { value: "L", label: "Low (L)" },
  { value: "M", label: "Medium (M)" },
  { value: "Q", label: "Quartile (Q)" },
  { value: "H", label: "High (H)" }
];

const DEFAULT_TEXT = "https://bamsense.works";

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const TEMPLATE_OPTIONS = [
  { value: "plain", label: "Plain text" },
  { value: "url", label: "Website / URL" },
  { value: "wifi", label: "WiFi" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "vcard", label: "vCard" }
];

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

export default function App() {
  const [template, setTemplate] = useState("plain");
  const [textInput, setTextInput] = useState(DEFAULT_TEXT);
  const [templateData, setTemplateData] = useState(() => ({
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
  }));
  const payload = template === "plain" ? textInput : buildTemplateText(template, templateData);
  const deferredPayload = useDeferredValue(payload);
  const [size, setSize] = useState(280);
  const [margin, setMargin] = useState(2);
  const [errorCorrection, setErrorCorrection] = useState("M");
  const [fgColor, setFgColor] = useState("#274c6f");
  const [bgColor, setBgColor] = useState("#ffffff");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrSvg, setQrSvg] = useState("");
  const [status, setStatus] = useState("Ready");
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

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      theme === "dark" ? "dark" : "light"
    );
    window.localStorage.setItem("bamsense-theme", theme);
  }, [theme]);

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
        light: bgColor
      }
    };

    Promise.all([
      QRCode.toDataURL(value, options),
      QRCode.toString(value, { ...options, type: "svg" })
    ])
      .then(([dataUrl, svg]) => {
        if (cancelled) {
          return;
        }
        setQrDataUrl(dataUrl);
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
  }, [deferredPayload, size, margin, errorCorrection, fgColor, bgColor]);

  const downloadPng = () => {
    if (!qrDataUrl) {
      return;
    }
    const link = document.createElement("a");
    link.href = qrDataUrl;
    link.download = "bamsense-qr.png";
    link.click();
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
  };

  const templateLabel =
    TEMPLATE_OPTIONS.find((option) => option.value === template)?.label ??
    "Plain text";

  const infoChips = [
    `Template: ${templateLabel}`,
    `Size: ${size}px`,
    `Margin: ${margin}`,
    `EC: ${errorCorrection}`
  ];

  const onSizeChange = (event) => {
    const value = Number(event.target.value);
    setSize(clampNumber(value, 160, 512));
  };

  const onMarginChange = (event) => {
    const value = Number(event.target.value);
    setMargin(clampNumber(value, 0, 8));
  };

  const onTemplateChange = (event) => {
    setTemplate(event.target.value);
  };

  const updateTemplateField = (field) => (event) => {
    const value =
      event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setTemplateData((prev) => ({ ...prev, [field]: value }));
  };

  const clearTemplateFields = (activeTemplate) => {
    setTemplateData((prev) => {
      const next = { ...prev };
      if (activeTemplate === "url") {
        next.url = "";
      } else if (activeTemplate === "wifi") {
        next.wifiSsid = "";
        next.wifiPassword = "";
        next.wifiType = "WPA";
        next.wifiHidden = false;
      } else if (activeTemplate === "email") {
        next.emailTo = "";
        next.emailSubject = "";
        next.emailBody = "";
      } else if (activeTemplate === "sms") {
        next.smsTo = "";
        next.smsBody = "";
      } else if (activeTemplate === "vcard") {
        next.vName = "";
        next.vOrg = "";
        next.vTitle = "";
        next.vPhone = "";
        next.vEmail = "";
        next.vUrl = "";
        next.vAddress = "";
      }
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
            <p className="privacy-title">
              Your files stay private. Processing runs 100% in your browser.
            </p>
          </div>
          <div className="privacy-tags">
            <span className="tag">Local only</span>
            <span className="tag">Open source</span>
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
                      />
                    </div>
                    <input
                      className="input mono"
                      value={bgColor}
                      onChange={(event) => setBgColor(event.target.value)}
                    />
                  </div>
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
            <div className="chip-row">
              {infoChips.map((chip) => (
                <span key={chip} className="chip">
                  {chip}
                </span>
              ))}
            </div>
          </div>
        </section>

      </main>

      <footer className="container footer">
        <div>
          <strong>Bamsense Works</strong> · Open-source QR tools for modern
          teams.
        </div>
        <div className="mono">MIT License · v0.1.0</div>
      </footer>
    </div>
  );
}
