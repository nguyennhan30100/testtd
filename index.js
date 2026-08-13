require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");

// Đăng ký font chữ riêng — BẮT BUỘC vì server/Docker thường không có sẵn font hệ thống,
// nếu thiếu bước này, ctx.fillText() sẽ chạy nhưng không vẽ được chữ nào (ảnh nền OK, chữ trống).
const FONT_PATH = path.join(__dirname, "assets", "fonts", "DejaVuSans-Bold.ttf");
try {
  GlobalFonts.registerFromPath(FONT_PATH, "AppFont");
} catch (e) {
  console.error("Font register error:", e.message);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = process.env.PREFIX || ".";
const DATA_FILE = path.join(__dirname, "data.json");
const GARENA_COOKIE = process.env.GARENA_COOKIE || "";

const KHUNG_GIO = {
  1: { label: "13h - 15h",   start: "13:00", end: "15:00" },
  2: { label: "15h - 17h",   start: "15:00", end: "17:00" },
  3: { label: "18h - 20h",     start: "18:00", end: "20:00" },
  4: { label: "20h - 21h50",   start: "20:00", end: "21:50" },
  5: { label: "21h40 - 23h30", start: "21:40", end: "23:30" },
  6: { label: "23h30 - 1h30",  start: "23:30", end: "01:30" },
  7: { label: "1h - 3h",     start: "01:00", end: "03:00" },
  8: { label: "10h - 12h",   start: "10:00", end: "12:00" },
};

// Cú pháp "xoaN" đi kèm ID để loại bỏ trận thứ N (tính theo thứ tự thời gian,
// bắt đầu từ 1) ra khỏi danh sách trận trước khi tính điểm/bảng xếp hạng.
// VD: .bxhcpr 4252953187 xoa3  → bỏ trận số 3, chỉ tính các trận còn lại.
const XOA_REGEX = /^xoa(\d+)$/i;

const HEADERS = {
  "Cookie": GARENA_COOKIE,
  "Content-Type": "application/json",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://congdong.ff.garena.vn/tinh-diem",
  "Origin": "https://congdong.ff.garena.vn",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

// ============================================================
// JSON STORAGE
// ============================================================
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (e) { console.error("loadData error:", e.message); }
  return {};
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8"); }
  catch (e) { console.error("saveData error:", e.message); }
}
const playerData = loadData();
const pendingStep = {}; // { userId: { step: "khung"|"date", accountId, channelId, guildId, soKhung } }

// ============================================================
// GARENA API
// ============================================================
async function findMatches(accountId, startTime, endTime) {
  const res = await axios.post(
    "https://congdong.ff.garena.vn/league-score-api/player/find-match",
    { accountId: String(accountId), startTime, endTime },
    { headers: HEADERS, timeout: 15000 }
  );
  return res.data?.matches || [];
}

async function getMatchDetail(matchId) {
  // POST /league-score-api/match với body { matchId }
  const res = await axios.post(
    "https://congdong.ff.garena.vn/league-score-api/match",
    { matchId: String(matchId) },
    { headers: HEADERS, timeout: 10000 }
  );
  return res.data?.match || null;
}

// Tìm player trong trận — ID bị che 2 số cuối: "70122364**" → so với "7012236439"
function findPlayer(match, accountId) {
  const accStr = String(accountId);
  for (const team of (match?.ranks || [])) {
    const idx = team.playerAccountIds.findIndex(pid => {
      const clean = pid.replace(/\*+$/, ""); // bỏ ** ở cuối
      return accStr.startsWith(clean);
    });
    if (idx !== -1) {
      // Ưu tiên lấy điểm cá nhân nếu API trả về (playerScores/playerKills/playerBooyahs)
      // Nếu không có thì fallback về điểm đội (chỉ đúng với đội solo)
      const playerScore  = Array.isArray(team.playerScores)  ? (team.playerScores[idx]  ?? team.score)  : team.score;
      const playerKill   = Array.isArray(team.playerKills)   ? (team.playerKills[idx]   ?? team.kill)   : team.kill;
      const playerBooyah = Array.isArray(team.playerBooyahs) ? (team.playerBooyahs[idx] ?? team.booyah) : team.booyah;
      return {
        rank:   team.rank,
        booyah: playerBooyah,
        kill:   playerKill,
        score:  playerScore,
        name:   team.accountNames[idx] || null,
      };
    }
  }
  return null;
}

// ============================================================
// TIMESTAMP
// ============================================================
function toTimestamp(dateStr, timeStr) {
  const [d, m, y] = dateStr.split("/");
  const [h, min] = timeStr.split(":");
  return Math.floor(new Date(`${y}-${m}-${d}T${h.padStart(2,"0")}:${min}:00+07:00`).getTime() / 1000);
}
function todayVN() {
  const vn = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  return `${String(vn.getDate()).padStart(2,"0")}/${String(vn.getMonth()+1).padStart(2,"0")}/${vn.getFullYear()}`;
}

// ============================================================
// VẼ ẢNH BXH (top đội theo điểm) — dùng cho .bxh
// ============================================================
function drawBxhImage(sortedTeams, { title, subtitle, playerName }) {
  const rowH = 64;
  const headerH = 140;
  const footerH = 40;
  const width = 900;
  const height = headerH + footerH + rowH * Math.max(sortedTeams.length, 1);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Nền gradient
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#1b1033");
  bg.addColorStop(1, "#0d0717");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Header
  ctx.fillStyle = "#ffa500";
  ctx.font = "bold 36px AppFont";
  ctx.textAlign = "center";
  ctx.fillText(title, width / 2, 56);

  ctx.fillStyle = "#cccccc";
  ctx.font = "20px AppFont";
  ctx.fillText(subtitle, width / 2, 90);

  // Header dòng cột
  ctx.textAlign = "left";
  ctx.font = "bold 18px AppFont";
  ctx.fillStyle = "#888888";
  ctx.fillText("HẠNG", 30, headerH - 10);
  ctx.fillText("TÊN ĐỘI", 130, headerH - 10);
  ctx.fillText("BOOYAH", 540, headerH - 10);
  ctx.fillText("HẠ GỤC", 660, headerH - 10);
  ctx.textAlign = "right";
  ctx.fillText("ĐIỂM", width - 30, headerH - 10);
  ctx.textAlign = "left";

  // Đường kẻ
  ctx.strokeStyle = "#444444";
  ctx.beginPath();
  ctx.moveTo(20, headerH);
  ctx.lineTo(width - 20, headerH);
  ctx.stroke();

  const medalColors = ["#FFD700", "#C0C0C0", "#CD7F32"];

  sortedTeams.forEach((squad, i) => {
    const y = headerH + i * rowH;
    const isMe = playerName && squad.rep === playerName;
    const isChampion = !!squad.champion;

    // Hàng nổi cho top 3 / chính mình
    if (i < 3) {
      ctx.fillStyle = "rgba(255,165,0,0.08)";
      ctx.fillRect(20, y, width - 40, rowH - 6);
    }
    if (isMe) {
      ctx.fillStyle = "rgba(0,191,255,0.15)";
      ctx.fillRect(20, y, width - 40, rowH - 6);
      ctx.strokeStyle = "#00bfff";
      ctx.strokeRect(20, y, width - 40, rowH - 6);
    }
    if (isChampion) {
      ctx.fillStyle = "rgba(255,215,0,0.18)";
      ctx.fillRect(20, y, width - 40, rowH - 6);
      ctx.strokeStyle = "#FFD700";
      ctx.lineWidth = 2;
      ctx.strokeRect(20, y, width - 40, rowH - 6);
      ctx.lineWidth = 1;
    }

    // Hạng
    ctx.font = "bold 26px AppFont";
    ctx.fillStyle = isChampion ? "#FFD700" : (medalColors[i] || "#ffffff");
    const rankLabel = isChampion ? "👑" : (i < 3 ? ["🥇","🥈","🥉"][i] : `#${i + 1}`);
    ctx.fillText(rankLabel, 30, y + 40);

    // Tên đội
    ctx.font = "bold 22px AppFont";
    ctx.fillStyle = isChampion ? "#FFD700" : (isMe ? "#00bfff" : "#ffffff");
    let name = squad.rep || "Unknown";
    if (name.length > 18) name = name.slice(0, 17) + "…";
    const suffix = isChampion ? "  👑 VÔ ĐỊCH" : (isMe ? "  ◀ Bạn" : "");
    ctx.fillText(name + suffix, 130, y + 40);

    // Booyah
    ctx.font = "20px AppFont";
    ctx.fillStyle = "#ffd700";
    ctx.fillText(String(squad.by ?? 0), 555, y + 40);

    // Kill
    ctx.fillStyle = "#ff6666";
    ctx.fillText(String(squad.kill ?? 0), 675, y + 40);

    // Điểm
    ctx.font = "bold 24px AppFont";
    ctx.fillStyle = isChampion ? "#FFD700" : "#ffa500";
    ctx.textAlign = "right";
    ctx.fillText(String(squad.score ?? 0), width - 30, y + 40);
    ctx.textAlign = "left";
  });

  // Footer
  ctx.textAlign = "center";
  ctx.font = "14px AppFont";
  ctx.fillStyle = "#777777";
  ctx.fillText("FREE FIRE • X6 ESP", width / 2, height - 14);

  return canvas.toBuffer("image/png");
}

// ============================================================
// VẼ ẢNH BXH TRÊN ẢNH MẪU "OVERALL STANDINGS" (assets/standings_template.jpg)
// — hàm MỚI, KHÔNG thay thế drawBxhImage cũ, chỉ vẽ đè text lên ảnh nền có sẵn
// ============================================================
const TEMPLATE_PATH = path.join(__dirname, "assets", "standings_template.jpg");
let _templateImgCache = null;
async function getTemplateImage() {
  if (!_templateImgCache) {
    _templateImgCache = await loadImage(TEMPLATE_PATH);
  }
  return _templateImgCache;
}

async function drawStandingsTemplateImage(sortedTeams, { subtitle } = {}) {
  const img = await getTemplateImage();
  const width = img.width;
  const height = img.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  // Toạ độ gốc đo trên ảnh mẫu kích thước 1037x1280 — tự scale nếu ảnh khác cỡ
  const scaleX = width / 1037;
  const scaleY = height / 1280;

  const xTeam   = 100 * scaleX;
  const xBooyah = 590 * scaleX;
  const xElims  = 672 * scaleX;
  const xPts    = 752 * scaleX;
  const yStart  = 418 * scaleY;
  const yStep   = 66  * scaleY;

  ctx.textBaseline = "middle";

  sortedTeams.slice(0, 12).forEach((squad, i) => {
    const y = yStart + i * yStep;

    // Tên đội
    ctx.font = `bold ${Math.round(28 * scaleY)}px AppFont`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    let name = squad.rep || "Unknown";
    if (name.length > 20) name = name.slice(0, 19) + "…";
    ctx.fillText(name, xTeam, y);

    // Booyah / Elims / Pts — căn giữa từng cột, chữ đen trên nền kem
    ctx.font = `bold ${Math.round(28 * scaleY)}px AppFont`;
    ctx.fillStyle = "#1a1a1a";
    ctx.textAlign = "center";
    ctx.fillText(String(squad.by ?? 0), xBooyah, y);
    ctx.fillText(String(squad.kill ?? 0), xElims, y);
    ctx.fillText(String(squad.score ?? 0), xPts, y);
  });

  if (subtitle) {
    ctx.font = `${Math.round(18 * scaleY)}px AppFont`;
    ctx.fillStyle = "#ffe6a8";
    ctx.textAlign = "left";
    ctx.fillText(subtitle, 115 * scaleX, 335 * scaleY);
  }

  return canvas.toBuffer("image/png");
}

// ============================================================
// VẼ ẢNH BXH TRÊN ẢNH MẪU 2 "BẢNG XẾP HẠNG" (Blue Lock)
// (assets/bluelock_template.jpg) — toạ độ đo trên ảnh gốc 902x1128
// Bố cục: hạng #1 nổi bật riêng + 2 cột (trái #2-#6, phải #7-#12)
// ============================================================
const BLUELOCK_TEMPLATE_PATH = path.join(__dirname, "assets", "bluelock_template.jpg");
let _bluelockImgCache = null;
async function getBluelockImage() {
  if (!_bluelockImgCache) {
    _bluelockImgCache = await loadImage(BLUELOCK_TEMPLATE_PATH);
  }
  return _bluelockImgCache;
}

const BLUELOCK_BASE_W = 902;
const BLUELOCK_BASE_H = 1128;
const BLUELOCK_COLS_LEFT  = { team: [112, 285], elim: [290, 328], by: [358, 386], pts: [405, 443] };
const BLUELOCK_COLS_RIGHT = { team: [550, 725], elim: [733, 771], by: [800, 832], pts: [858, 893] };
const BLUELOCK_RANK1_Y     = 425;
const BLUELOCK_LEFT_ROWS   = { 2: 502, 3: 547, 4: 588, 5: 630, 6: 667 };
const BLUELOCK_RIGHT_ROWS  = { 7: 464, 8: 502, 9: 542, 10: 582, 11: 622, 12: 662 };

async function drawBluelockTemplateImage(sortedTeams) {
  const img = await getBluelockImage();
  const width = img.width;
  const height = img.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  const scaleX = width / BLUELOCK_BASE_W;
  const scaleY = height / BLUELOCK_BASE_H;
  ctx.textBaseline = "middle";

  function drawCell([x1, x2], y, str, { align = "center", color = "#ffffff", size = 18 } = {}) {
    ctx.font = `bold ${Math.round(size * scaleY)}px AppFont`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    const x = align === "left" ? x1 * scaleX + 4 : ((x1 + x2) / 2) * scaleX;
    let text = str;
    if (align === "left" && text.length > 18) text = text.slice(0, 17) + "…";
    ctx.fillText(text, x, y * scaleY);
  }

  function drawRow(cols, y, squad, size) {
    if (!squad) return;
    drawCell(cols.team, y, squad.rep || "Unknown", { align: "left", color: "#ffffff", size });
    drawCell(cols.elim, y, String(squad.kill ?? 0), { align: "center", color: "#ffffff", size });
    drawCell(cols.by,   y, String(squad.by ?? 0),   { align: "center", color: "#ffffff", size });
    drawCell(cols.pts,  y, String(squad.score ?? 0),{ align: "center", color: "#ffffff", size });
  }

  // Hạng #1 — nổi bật riêng
  if (sortedTeams[0]) {
    drawRow(BLUELOCK_COLS_LEFT, BLUELOCK_RANK1_Y, sortedTeams[0], 20);
  }
  // Hạng #2-#6 (cột trái)
  Object.entries(BLUELOCK_LEFT_ROWS).forEach(([rank, y]) => {
    drawRow(BLUELOCK_COLS_LEFT, y, sortedTeams[parseInt(rank) - 1], 18);
  });
  // Hạng #7-#12 (cột phải)
  Object.entries(BLUELOCK_RIGHT_ROWS).forEach(([rank, y]) => {
    drawRow(BLUELOCK_COLS_RIGHT, y, sortedTeams[parseInt(rank) - 1], 18);
  });

  return canvas.toBuffer("image/png");
}

// ============================================================
// VẼ ẢNH BXH TRÊN ẢNH MẪU 4 "BẢNG XẾP HẠNG" (Hello Kitty, hồng)
// (assets/hellokitty_template.jpg) — toạ độ đo trên ảnh gốc 1264x843
// Bố cục: 2 bảng đối xứng, mỗi bảng 6 hạng, không có ô #1 riêng
// ============================================================
const HK_TEMPLATE_PATH = path.join(__dirname, "assets", "hellokitty_template.jpg");
let _hkImgCache = null;
async function getHkImage() {
  if (!_hkImgCache) {
    _hkImgCache = await loadImage(HK_TEMPLATE_PATH);
  }
  return _hkImgCache;
}

const HK_BASE_W = 1264;
const HK_BASE_H = 843;
const HK_COLS_LEFT  = { team: [150, 300], elim: [300, 412], by: [412, 537], pts: [537, 606] };
const HK_COLS_RIGHT = { team: [750, 902], elim: [902, 1005], by: [1005, 1130], pts: [1130, 1202] };
const HK_ROWS_Y = [288, 342, 396, 450, 504, 558]; // hạng 1-6 (trái) và 7-12 (phải) dùng chung

async function drawHkTemplateImage(sortedTeams) {
  const img = await getHkImage();
  const width = img.width;
  const height = img.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  const scaleX = width / HK_BASE_W;
  const scaleY = height / HK_BASE_H;
  ctx.textBaseline = "middle";

  function drawCell([x1, x2], y, str, { align = "center", color = "#7a3b52", size = 16 } = {}) {
    ctx.font = `bold ${Math.round(size * scaleY)}px AppFont`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    const x = align === "left" ? x1 * scaleX + 4 : ((x1 + x2) / 2) * scaleX;
    let text = str;
    if (align === "left" && text.length > 16) text = text.slice(0, 15) + "…";
    ctx.fillText(text, x, y * scaleY);
  }

  function drawRow(cols, y, squad) {
    if (!squad) return;
    drawCell(cols.team, y, squad.rep || "Unknown", { align: "left", size: 16 });
    drawCell(cols.elim, y, String(squad.kill ?? 0), { align: "center", size: 16 });
    drawCell(cols.by,   y, String(squad.by ?? 0),   { align: "center", size: 16 });
    drawCell(cols.pts,  y, String(squad.score ?? 0),{ align: "center", size: 16 });
  }

  // Hạng #1-#6 (trái)
  HK_ROWS_Y.forEach((y, i) => drawRow(HK_COLS_LEFT, y, sortedTeams[i]));
  // Hạng #7-#12 (phải)
  HK_ROWS_Y.forEach((y, i) => drawRow(HK_COLS_RIGHT, y, sortedTeams[i + 6]));

  return canvas.toBuffer("image/png");
}

// ============================================================
// VẼ ẢNH BXH TRÊN ẢNH MẪU 5 "BẢNG XẾP HẠNG" (nền đen, xích sắt, 2 nhân vật)
// (assets/chain_template.jpg) — toạ độ đo trên ảnh gốc 2028x2560
// Bố cục: 1 cột dài, 12 hạng xếp dọc, rank #1-#12 đã có sẵn trong ảnh nền
// ============================================================
const CHAIN_TEMPLATE_PATH = path.join(__dirname, "assets", "chain_template.jpg");
let _chainImgCache = null;
async function getChainImage() {
  if (!_chainImgCache) {
    _chainImgCache = await loadImage(CHAIN_TEMPLATE_PATH);
  }
  return _chainImgCache;
}

const CHAIN_BASE_W = 2028;
const CHAIN_BASE_H = 2560;

// Cột: team căn trái (bắt đầu sau dấu "|"), elim/by/pts căn giữa
const CHAIN_COLS = {
  team: [1010, 1550],
  elim: [1647, 1647],
  by:   [1780, 1780],
  pts:  [1925, 1925],
};

// Tâm y của từng hạng #1 -> #12
const CHAIN_ROWS = {
  1: 895,  2: 1009, 3: 1124, 4: 1238,
  5: 1352, 6: 1467, 7: 1581, 8: 1696,
  9: 1810, 10: 1924, 11: 2039, 12: 2153,
};

async function drawChainTemplateImage(sortedTeams) {
  const img = await getChainImage();
  const width = img.width;
  const height = img.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  const scaleX = width / CHAIN_BASE_W;
  const scaleY = height / CHAIN_BASE_H;
  ctx.textBaseline = "middle";

  function drawCell([x1, x2], y, str, { align = "center", color = "#ffffff", size = 30 } = {}) {
    ctx.font = `bold ${Math.round(size * scaleY)}px AppFont`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    const x = align === "left" ? x1 * scaleX + 4 : ((x1 + x2) / 2) * scaleX;
    let text = str;
    if (align === "left" && text.length > 18) text = text.slice(0, 17) + "…";
    ctx.fillText(text, x, y * scaleY);
  }

  Object.entries(CHAIN_ROWS).forEach(([rank, y]) => {
    const t = sortedTeams[parseInt(rank) - 1];
    if (!t) return;
    drawCell(CHAIN_COLS.team, y, t.rep || "Unknown", { align: "left",  color: "#ffffff", size: 30 });
    drawCell(CHAIN_COLS.elim, y, String(t.kill ?? 0), { align: "center", color: "#ffffff", size: 28 });
    drawCell(CHAIN_COLS.by,   y, String(t.by ?? 0),   { align: "center", color: "#ffe600", size: 28 });
    drawCell(CHAIN_COLS.pts,  y, String(t.score ?? 0),{ align: "center", color: "#ffa500", size: 30 });
  });

  return canvas.toBuffer("image/png");
}

// ============================================================
// LOGIC "VÔ ĐỊCH" (CPR) cho .bxhcpr
//
// Luật: Xét tối đa 5 trận đầu (theo thời gian).
// - Sau MỖI trận, cộng dồn điểm cho tất cả đội (kể cả điểm của
//   chính trận đó).
// - Nếu đội TOP1 (giành booyah) của trận đó có tổng điểm cộng dồn
//   TÍNH ĐẾN HẾT TRẬN NÀY (bao gồm cả điểm trận này) đạt ≥ ngưỡng
//   (mặc định 50đ, tuỳ chỉnh qua cú pháp cprN) → VÔ ĐỊCH NGAY,
//   dừng xét các trận còn lại.
// - Một đội chưa đạt ngưỡng mà top1 thì KHÔNG thắng.
// - Nếu hết 5 trận mà không có đội nào top1 với tổng điểm ≥ngưỡng
//   → không có đội vô địch, xếp hạng theo tổng điểm như thường.
// - Mỗi trận chỉ có 1 đội top1 nên không xảy ra tranh chấp.
//
// matchesOrdered: mảng match detail (đã có .ranks), theo thứ tự thời gian.
// threshold: ngưỡng điểm kích hoạt vô địch (mặc định 50).
// Trả về: { sortedTeams, hasChampion }
// ============================================================
// ============================================================
// LOGIC "VÔ ĐỊCH" (CPR) cho .bxhcpr
//
// Luật: Xét tối đa 5 trận đầu (theo thời gian).
// - Một đội được coi là "đã kích hoạt CPR" khi tổng điểm cộng dồn
//   của nó (tính đến HẾT một trận, KHÔNG tính điểm trận đang xét
//   tiếp theo) đạt ≥ ngưỡng (mặc định 50đ, tuỳ chỉnh qua cprN).
// - Đội ĐÃ kích hoạt CPR (từ trận trước) mà sau đó TOP1 (giành
//   booyah) ở MỘT TRẬN BẤT KỲ tiếp theo → VÔ ĐỊCH NGAY, dừng xét
//   các trận còn lại.
// - Điểm của chính trận top1 đang xét KHÔNG được dùng để tính mốc
//   kích hoạt — nếu đội chỉ vừa đủ ngưỡng NHỜ điểm trận đó thì
//   chưa được tính là "đã kích hoạt" ở trận đó (phải đợi top1 ở
//   trận sau nữa mới được).
// - Một đội chưa kích hoạt CPR mà top1 thì KHÔNG thắng.
// - Nếu hết 5 trận mà không đội nào (đã kích hoạt CPR) từng giành
//   booyah sau khi kích hoạt → không có đội vô địch, xếp hạng
//   theo tổng điểm như thường.
// - Mỗi trận chỉ có 1 đội top1 nên không xảy ra tranh chấp.
//
// matchesOrdered: mảng match detail (đã có .ranks), theo thứ tự thời gian.
// threshold: ngưỡng điểm kích hoạt vô địch (mặc định 50).
// Trả về: { sortedTeams, hasChampion }
// ============================================================
function computeChampionBoard(matchesOrdered, threshold = 50) {
  const MAX_MATCHES = 5;
  const limited = matchesOrdered.slice(0, MAX_MATCHES);

  const teamTotals = {}; // key(cleanIds joined) -> { rep, by, kill, score, cleanIds }
  const cprActivated = new Set(); // key của các đội đã đạt ≥ngưỡng (đã kích hoạt CPR)
  let championKey = null;

  for (const match of limited) {
    if (championKey) break; // đã có đội vô địch ở trận trước, dừng hẳn

    const ranks = match?.ranks || [];

    // Bước 1: kiểm tra đội TOP1 của TRẬN NÀY — nếu đội đó ĐÃ kích hoạt CPR
    // TỪ TRƯỚC trận này (tổng điểm tính đến HẾT TRẬN TRƯỚC đã ≥ngưỡng) → vô địch ngay.
    // Lưu ý: điểm của chính trận top1 này KHÔNG được tính vào mốc kích hoạt —
    // nếu đội chỉ vừa đạt đủ ngưỡng NHỜ điểm của trận đang xét thì chưa được tính.
    const top1Team = ranks.find(t => t.rank === 1);
    if (top1Team) {
      const top1Key = top1Team.playerAccountIds
        .map(pid => pid.replace(/\*+$/, ""))
        .sort()
        .join("|");
      if (cprActivated.has(top1Key)) {
        championKey = top1Key;
      }
    }

    // Bước 2: cộng điểm trận này vào tổng cho TẤT CẢ đội
    for (const team of ranks) {
      const cleanIds = team.playerAccountIds
        .map(pid => pid.replace(/\*+$/, ""))
        .sort()
        .join("|");
      const repName = team.accountNames?.[0] || cleanIds;
      if (!teamTotals[cleanIds]) {
        teamTotals[cleanIds] = { rep: repName, by: 0, kill: 0, score: 0, cleanIds };
      }
      teamTotals[cleanIds].by    += team.booyah || 0;
      teamTotals[cleanIds].kill  += team.kill || 0;
      teamTotals[cleanIds].score += team.score || 0;
    }

    // Bước 3: cập nhật tập "đã kích hoạt CPR" cho TẤT CẢ đội đạt ≥ngưỡng TÍNH ĐẾN HẾT TRẬN NÀY
    // (sẽ có hiệu lực để xét top1 ở TRẬN SAU, không áp dụng cho trận này nữa)
    for (const key of Object.keys(teamTotals)) {
      if (teamTotals[key].score >= threshold) cprActivated.add(key);
    }
  }

  // ── Gộp đội thông minh giống logic .td (giao ≥2 ID → cùng đội) ──
  const rawTeams = Object.values(teamTotals).map(v => ({
    cleanIds: new Set(v.cleanIds.split("|")),
    rep: v.rep, by: v.by, kill: v.kill, score: v.score,
  }));
  const merged = [];
  const used = new Array(rawTeams.length).fill(false);
  for (let i = 0; i < rawTeams.length; i++) {
    if (used[i]) continue;
    let group = { ...rawTeams[i], cleanIds: new Set(rawTeams[i].cleanIds) };
    used[i] = true;
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < rawTeams.length; j++) {
        if (used[j]) continue;
        const inter = [...rawTeams[j].cleanIds].filter(id => group.cleanIds.has(id));
        if (inter.length >= 2) {
          group.by += rawTeams[j].by;
          group.kill += rawTeams[j].kill;
          group.score += rawTeams[j].score;
          rawTeams[j].cleanIds.forEach(id => group.cleanIds.add(id));
          used[j] = true;
          changed = true;
        }
      }
    }
    merged.push(group);
  }

  // Đánh dấu đội vô địch (so theo giao ID với championKey)
  let championGroup = null;
  if (championKey) {
    const champIdSet = new Set(championKey.split("|"));
    championGroup = merged.find(g => [...g.cleanIds].some(id => champIdSet.has(id)));
  }

  // Sắp xếp: đội vô địch lên đầu, còn lại theo điểm giảm dần
  let sorted;
  if (championGroup) {
    const rest = merged.filter(g => g !== championGroup).sort((a, b) => b.score - a.score);
    sorted = [{ ...championGroup, champion: true }, ...rest];
  } else {
    sorted = merged.sort((a, b) => b.score - a.score);
  }

  return { sortedTeams: sorted.slice(0, 12), hasChampion: !!championGroup };
}

// ============================================================
// MESSAGE HANDLER
// ============================================================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild?.id;
  if (!guildId) return;
  if (!playerData[guildId]) playerData[guildId] = {};

  const uid = message.author.id;
  const text = message.content.trim();
  const pending = pendingStep[uid];

  // ══════════════════════════════════════════════════════════
  // BƯỚC 2: Chọn khung giờ (nhập 1-8, không cần prefix)
  // ══════════════════════════════════════════════════════════
  if (pending?.step === "khung" && pending.channelId === message.channel.id) {
    if (!/^[1-8]$/.test(text)) return message.reply("❌ Nhập số từ **1-8**!");
    pendingStep[uid] = { ...pending, step: "date", soKhung: parseInt(text) };
    return message.reply(`📅 Nhập **ngày thi đấu** (DD/MM/YYYY)\nVí dụ: \`${todayVN()}\``);
  }

  // ══════════════════════════════════════════════════════════
  // BƯỚC 3: Nhập ngày
  // ══════════════════════════════════════════════════════════
  if (pending?.step === "date" && pending.channelId === message.channel.id) {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
      return message.reply("❌ Sai định dạng! Nhập lại: `DD/MM/YYYY`");
    }
    pendingStep[uid] = { ...pending, step: "template", ngay: text };
    const embed = new EmbedBuilder()
      .setTitle("🖼️ CHỌN MẪU ẢNH BẢNG XẾP HẠNG")
      .setColor(0x00bfff)
      .setDescription("`1` — Mẫu Overall Standings\n`2` — Mẫu Bảng Xếp Hạng (Blue Lock)\n`3` — Mẫu Bảng Xếp Hạng (Hello Kitty)\n`4` — Mẫu Bảng Xếp Hạng (Xích Sắt)")
      .addFields({ name: "✏️ Hướng dẫn", value: "Trả lời `1`, `2`, `3` hoặc `4`" });
    return message.reply({ embeds: [embed] });
  }

  // ══════════════════════════════════════════════════════════
  // BƯỚC 4: Chọn mẫu ảnh (1, 2, 3 hoặc 4)
  // ══════════════════════════════════════════════════════════
  if (pending?.step === "template" && pending.channelId === message.channel.id) {
    if (!/^[1234]$/.test(text)) return message.reply("❌ Chỉ nhập `1`, `2`, `3` hoặc `4`!");

    const selectedTemplate = parseInt(text);
    const { accountId, soKhung, guildId: gid, mode, ngay, excludeMatchIndex, cprThreshold } = pending;
    delete pendingStep[uid];
    const kg = KHUNG_GIO[soKhung];

    // Hàm dùng chung để vẽ đúng mẫu người dùng đã chọn
    async function drawSelectedTemplate(sortedTeams, subtitleText) {
      if (selectedTemplate === 4) {
        return drawChainTemplateImage(sortedTeams);
      }
      if (selectedTemplate === 3) {
        return drawHkTemplateImage(sortedTeams);
      }
      if (selectedTemplate === 2) {
        return drawBluelockTemplateImage(sortedTeams);
      }
      return drawStandingsTemplateImage(sortedTeams, { subtitle: subtitleText });
    }

    // Tính timestamp
    let startTs = toTimestamp(ngay, kg.start);
    let endTs   = toTimestamp(ngay, kg.end);
    // Khung qua nửa đêm
    if (soKhung === 6) endTs += 86400;
    if (soKhung === 7) { startTs += 86400; endTs += 86400; }

    const loadMsg = await message.reply(`⏳ Đang tìm trận của ID **${accountId}** trong **${kg.label}** ngày **${ngay}**...`);

    try {
      // Bước 1: Lấy danh sách trận
      const matches = await findMatches(accountId, startTs, endTs);

      // QUAN TRỌNG: sắp xếp trận theo thời gian TĂNG DẦN (trận cũ nhất → mới nhất).
      // Logic vô địch (.bxhcpr) yêu cầu xét đúng thứ tự thời gian ("kích hoạt ở
      // trận trước → ăn top1 ở trận SAU"), nếu API trả về không đúng thứ tự
      // (VD: mới nhất trước) thì kết quả vô địch sẽ sai hoàn toàn.
      // Thử theo các tên field thời gian phổ biến, fallback về id nếu không có.
      matches.sort((a, b) => {
        const ta = a.startTime ?? a.startTs ?? a.createTime ?? a.matchTime ?? a.timestamp ?? a.id;
        const tb = b.startTime ?? b.startTs ?? b.createTime ?? b.matchTime ?? b.timestamp ?? b.id;
        return ta - tb;
      });
      if (matches[0]) {
        console.log("[DEBUG] Sample match object (kiểm tra field thời gian):", JSON.stringify(matches[0]));
      }

      // Nếu người dùng yêu cầu xoá trận lỗi (VD: "xoa3") — loại bỏ trận đó
      // ra khỏi danh sách trước khi lấy chi tiết/tính điểm.
      let removedNote = "";
      if (excludeMatchIndex) {
        if (excludeMatchIndex >= 1 && excludeMatchIndex <= matches.length) {
          const removed = matches.splice(excludeMatchIndex - 1, 1)[0];
          removedNote = `🗑️ Đã xoá trận số **${excludeMatchIndex}** (ID: \`${removed?.id ?? "?"}\`) khỏi danh sách tính điểm.\n`;
        } else {
          removedNote = `⚠️ Không có trận số **${excludeMatchIndex}** để xoá (chỉ tìm thấy ${matches.length} trận ban đầu) — vẫn tính toàn bộ.\n`;
        }
      }

      if (matches.length === 0) {
        return loadMsg.edit(`${removedNote}❌ Không còn trận nào để tính trong khung **${kg.label}** ngày **${ngay}**!`);
      }

      await loadMsg.edit(`${removedNote}⏳ Tìm thấy **${matches.length}** trận${excludeMatchIndex ? " (sau khi xoá)" : ""}. Đang lấy chi tiết...`);

      // Bước 2: Lấy chi tiết từng trận
      const teamMap = {};
      const teamTotals = {}; // gộp điểm 12 đội qua tất cả các trận
      const matchDetails = []; // lưu theo thứ tự thời gian — dùng cho logic vô địch (.bxhcpr)
      const accStr = String(accountId);
      let playerName = null, totalBy = 0, totalElims = 0, totalPts = 0;

      for (let i = 0; i < matches.length; i++) {
        try {
          const match = await getMatchDetail(matches[i].id);
          if (!match) continue;
          const matchId = matches[i].id;
          matchDetails.push(match);

          // Dùng findPlayer để tìm chính xác người dùng trong trận này
          const found = findPlayer(match, accountId);
          if (found) {
            if (!playerName && found.name) playerName = found.name;
            totalBy    += found.booyah;
            totalElims += found.kill;
            totalPts   += found.score;
            // DEBUG: log để kiểm tra điểm từng trận
            console.log(`[Match ${matches[i].id}] ${found.name} => score:${found.score} kill:${found.kill} booyah:${found.booyah}`);
          } else {
            console.log(`[Match ${matches[i].id}] Khong tim thay player ${accountId} trong tran nay`);
          }

          // Cộng dồn điểm từng đội
          // Key = phần ID không che (ổn định hơn tên) sort lại để tránh lệch thứ tự
          for (const team of (match.ranks || [])) {
            const cleanIds = team.playerAccountIds
              .map(pid => pid.replace(/\*+$/, ""))
              .sort()
              .join("|");
            const repName = team.accountNames[0] || cleanIds;
            const isNew = !teamTotals[cleanIds];
            if (isNew) {
              teamTotals[cleanIds] = { rep: repName, by: 0, kill: 0, score: 0 };
            }
            teamTotals[cleanIds].by    += team.booyah;
            teamTotals[cleanIds].kill  += team.kill;
            teamTotals[cleanIds].score += team.score;
            console.log(`[Match ${matchId}] ${isNew?"NEW":"UPD"} ${repName} key=${cleanIds.slice(0,30)} score+=${team.score}(total:${teamTotals[cleanIds].score}) kill+=${team.kill}(total:${teamTotals[cleanIds].kill})`);
          }
        } catch (e) {
          console.error("Match error:", e.response?.status || e.message);
        }
        await new Promise(r => setTimeout(r, 400));
      }

      playerName = playerName || `ID_${accountId}`;

      // ── Gộp đội thông minh: 2 entry có ≥2 ID trùng nhau → cùng đội ──
      // rawTeams: mảng { cleanIds: Set, rep, by, kill, score }
      const rawTeams = Object.entries(teamTotals).map(([key, val]) => ({
        cleanIds: new Set(key.split("|")),
        rep:   val.rep,
        by:    val.by,
        kill:  val.kill,
        score: val.score,
      }));

      // Gộp các nhóm có giao ≥2 ID
      const merged = [];
      const used = new Array(rawTeams.length).fill(false);
      for (let i = 0; i < rawTeams.length; i++) {
        if (used[i]) continue;
        let group = { ...rawTeams[i], cleanIds: new Set(rawTeams[i].cleanIds) };
        used[i] = true;
        // Lặp lại để gộp dây chuyền (A~B, B~C → A~B~C)
        let changed = true;
        while (changed) {
          changed = false;
          for (let j = 0; j < rawTeams.length; j++) {
            if (used[j]) continue;
            const inter = [...rawTeams[j].cleanIds].filter(id => group.cleanIds.has(id));
            if (inter.length >= 2) {
              group.by    += rawTeams[j].by;
              group.kill  += rawTeams[j].kill;
              group.score += rawTeams[j].score;
              rawTeams[j].cleanIds.forEach(id => group.cleanIds.add(id));
              used[j] = true;
              changed = true;
            }
          }
        }
        merged.push(group);
      }

      // DEBUG: log toàn bộ merged trước khi sort
      console.log("=== MERGED TEAMS ===");
      merged.forEach((t, i) => console.log(`[${i}] ${t.rep} | score:${t.score} kill:${t.kill} by:${t.by} | ids:${[...t.cleanIds].join(",")}`));

      // Sắp xếp bảng theo điểm giảm dần — mỗi đội 1 đại diện
      const sorted = merged.sort((a, b) => b.score - a.score).slice(0, 12);

      // ══════════════════════════════════════════════════════
      // CHẾ ĐỘ VÔ ĐỊCH (.bxhcpr) — vẽ ảnh, KHÔNG lưu data
      // ══════════════════════════════════════════════════════
      if (mode === "bxhcpr") {
        const threshold = cprThreshold || 50;
        const { sortedTeams, hasChampion } = computeChampionBoard(matchDetails, threshold);
        const usedMatches = Math.min(matchDetails.length, 5);
        const buffer = drawBxhImage(sortedTeams, {
          title: hasChampion ? "👑 BẢNG XẾP HẠNG — CÓ VÔ ĐỊCH" : "🔥 BẢNG XẾP HẠNG",
          subtitle: `${kg.label} • ngày ${ngay} • ID: ${accountId} • ${usedMatches}/${Math.min(matches.length,5)} trận xét`,
          playerName,
        });
        const attachment = new AttachmentBuilder(buffer, { name: "bxhcpr.png" });

        const files = [attachment];
        try {
          const tplBuffer = await drawSelectedTemplate(
            sortedTeams,
            `${kg.label} • ngày ${ngay} • ${usedMatches} trận xét`
          );
          files.push(new AttachmentBuilder(tplBuffer, { name: `standings_bxhcpr_mau${selectedTemplate}.png` }));
        } catch (e) {
          console.error("drawSelectedTemplate (bxhcpr) error:", e.message);
        }

        const statusLine = hasChampion
          ? `👑 Đã có đội VÔ ĐỊCH (đạt ≥${threshold}đ & top1) sau ${usedMatches} trận — các trận sau không xét.`
          : `📊 Chưa có đội đủ điều kiện vô địch (ngưỡng ${threshold}đ) sau ${usedMatches} trận — xếp hạng theo tổng điểm.`;
        return loadMsg.edit({
          content: `${removedNote}${statusLine}`,
          files,
        });
      }

      // Lưu
      if (!playerData[gid]) playerData[gid] = {};
      playerData[gid][uid] = {
        accountId, discordId: uid, name: playerName,
        khungGio: kg.label, ngay,
        totalBy, totalElims, totalPts,
        luot: playerData[gid][uid]?.luot ?? 9,
        matches: matches.length,
      };
      saveData(playerData);

      const medals = ["🥇","🥈","🥉"];
      let board = "";
      sorted.forEach((squad, i) => {
        const isMe = squad.rep === playerName;
        const rankLabel = medals[i] || `#${i+1}`;
        board += `${rankLabel}${isMe ? " **◀**" : ""} **${squad.rep}** | BY:\`${squad.by}\` EL:\`${squad.kill}\` | **${squad.score}pts**\n`;
      });
      if (board.length > 4000) board = board.slice(0, 4000) + "...";

      const embed = new EmbedBuilder()
        .setTitle(`🔥 BXH TỔNG — ${kg.label} ngày ${ngay}`)
        .setColor(0xffa500)
        .setDescription(board || "Không có dữ liệu")
        .addFields(
          { name: "👤 Bạn",     value: playerName,          inline: true },
          { name: "🏆 BOOYAH",  value: `${totalBy}`,        inline: true },
          { name: "💀 HẠ GỤC", value: `${totalElims}`,     inline: true },
          { name: "⭐ ĐIỂM",    value: `${totalPts}`,       inline: true },
          { name: "🎮 Số trận", value: `${matches.length}`, inline: true },
        )
        .setFooter({ text: "FREE FIRE • X6 ESP" })
        .setTimestamp();

      const tdFiles = [];
      try {
        const tplBuffer = await drawSelectedTemplate(sorted, `${kg.label} • ngày ${ngay}`);
        tdFiles.push(new AttachmentBuilder(tplBuffer, { name: `standings_td_mau${selectedTemplate}.png` }));
      } catch (e) {
        console.error("drawSelectedTemplate (td) error:", e.message);
      }

      return loadMsg.edit({ content: removedNote, embeds: [embed], files: tdFiles });

    } catch (err) {
      console.error("Error:", err.response?.status, err.message);
      return loadMsg.edit(`❌ Lỗi API: ${err.response?.status || err.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // LỆNH CÓ PREFIX
  // ══════════════════════════════════════════════════════════
  if (!text.startsWith(PREFIX)) return;
  const args = text.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // .td [ID] [cpr|cprN] [xoaN]  — 1 lệnh duy nhất thay cho .td / .bxh / .bxhcpr cũ
  // - .td 60967899          → chế độ thường (embed + lưu data)
  // - .td 60967899 cpr      → chế độ "vô địch" (đội ≥50đ & top1 được đưa lên #1), không lưu data
  // - .td 60967899 cpr40    → chế độ "vô địch" nhưng ngưỡng kích hoạt là 40đ thay vì mặc định 50đ
  // - Thêm "xoaN" ở bất kỳ đâu sau ID để bỏ trận thứ N. VD: .td 60967899 cpr40 xoa3
  if (cmd === "td") {
    const accountId = args[1];
    if (!accountId || !/^\d+$/.test(accountId)) {
      return message.reply("❌ VD: `.td 60967899` hoặc `.td 60967899 cpr` / `.td 60967899 cpr40` (thêm `xoa3` để bỏ trận số 3)");
    }

    let isCpr = false;
    let cprThreshold = 50;
    let excludeMatchIndex = null;
    for (const a of args.slice(2)) {
      const cprMatch = /^cpr(\d+)?$/i.exec(a);
      if (cprMatch) {
        isCpr = true;
        if (cprMatch[1]) cprThreshold = parseInt(cprMatch[1]);
        continue;
      }
      const xoaMatch = XOA_REGEX.exec(a);
      if (xoaMatch) excludeMatchIndex = parseInt(xoaMatch[1]);
    }

    const mode = isCpr ? "bxhcpr" : "td";
    pendingStep[uid] = { step: "khung", accountId, channelId: message.channel.id, guildId, mode, excludeMatchIndex, cprThreshold };
    const embed = new EmbedBuilder()
      .setTitle(isCpr ? "📋 CHỌN KHUNG GIỜ (BXH Vô Địch)" : "📋 CHỌN KHUNG GIỜ")
      .setColor(0x00bfff)
      .setDescription(Object.entries(KHUNG_GIO).map(([k,v]) => `\`${k}\` — ${v.label}`).join("\n"))
      .addFields({ name: "✏️ Hướng dẫn", value: "Trả lời số từ **1-8**" })
      .setFooter({ text: `ID: ${accountId}${isCpr ? ` • chế độ CPR (ngưỡng ${cprThreshold}đ)` : ""}${excludeMatchIndex ? ` • sẽ bỏ trận #${excludeMatchIndex}` : ""} • ${message.author.username}` });
    return message.reply({ embeds: [embed] });
  }

  // .help
  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setTitle("📖 HƯỚNG DẪN BOT FF")
      .setColor(0xffd700)
      .addFields(
        { name: "👤 Người chơi", value: "`.td [ID]` — Đăng ký + tìm trận (embed + lưu data)\n`.td [ID] cpr` — BXH có luật Vô Địch (≥50đ & top1 ván đó), không lưu data\n`.td [ID] cprN` — như trên nhưng ngưỡng kích hoạt là **N** điểm thay vì 50 (VD: `cpr40`)" },
        { name: "🗑️ Xoá trận lỗi", value: "Thêm `xoaN` sau ID (bất kỳ vị trí nào) để bỏ trận thứ N (theo thứ tự thời gian) ra khỏi danh sách tính điểm.\nVD: `.td 4252953187 cpr40 xoa3` → chế độ CPR ngưỡng 40đ, bỏ trận số 3, chỉ tính các trận còn lại." },
        { name: "⚙️ Luồng",      value: "1️⃣ `.td [ID]` (thêm `cpr`/`cprN` và/hoặc `xoaN` nếu cần) → 2️⃣ Chọn khung giờ (1-8) → 3️⃣ Nhập ngày → 4️⃣ Chọn mẫu ảnh (1, 2, 3 hoặc 4) → 5️⃣ Bot tự lấy điểm từ Garena!" },
      )
      .setFooter({ text: "FREE FIRE • X6 ESP Bot" });
    return message.reply({ embeds: [embed] });
  }
});

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  client.user.setActivity("Free Fire | .help", { type: 0 });
});

client.login(process.env.DISCORD_TOKEN);
