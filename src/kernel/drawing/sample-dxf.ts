/**
 * 実務の建築実施設計図を模したオリジナル合成サンプルデータ。
 * - `A-01_1F平面図.dxf`: RC 造 1 階平面図（S=1/100、通り芯・3段寸法・RC柱・二重線外壁/間仕切・
 *   折り返し階段・WC/PS/EPS・給湯室・執務室・会議室A・応接室・建具符号・方位記号・図面枠・表題欄）
 * - `仕上表・建具表.csv`: 平面図の室名・建具符号と対応する内部仕上表・建具表
 * - `設計メモ・確認事項.md`: 設計レビュー・チェック用メモ
 */

export const SAMPLE_DRAWING_PATH = "A-01_1F平面図.dxf";
export const SAMPLE_SCHEDULE_PATH = "仕上表・建具表.csv";
export const SAMPLE_NOTES_PATH = "設計メモ・確認事項.md";

type SpanOpening = {
  start: number;
  end: number;
};

class DxfBuilder {
  private readonly entities: string[] = [];
  private nextHandle = 0x100;

  private allocHandle(): string {
    const h = this.nextHandle.toString(16).toUpperCase();
    this.nextHandle += 1;
    return h;
  }

  private fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  }

  line(layer: string, x1: number, y1: number, x2: number, y2: number, ltype?: string): void {
    this.entities.push(
      "0",
      "LINE",
      "5",
      this.allocHandle(),
      "8",
      layer,
      ...(ltype ? ["6", ltype] : []),
      "10",
      this.fmt(x1),
      "20",
      this.fmt(y1),
      "11",
      this.fmt(x2),
      "21",
      this.fmt(y2),
    );
  }

  rect(layer: string, x1: number, y1: number, x2: number, y2: number, ltype?: string): void {
    this.line(layer, x1, y1, x2, y1, ltype);
    this.line(layer, x2, y1, x2, y2, ltype);
    this.line(layer, x2, y2, x1, y2, ltype);
    this.line(layer, x1, y2, x1, y1, ltype);
  }

  circle(layer: string, cx: number, cy: number, r: number): void {
    this.entities.push(
      "0",
      "CIRCLE",
      "5",
      this.allocHandle(),
      "8",
      layer,
      "10",
      this.fmt(cx),
      "20",
      this.fmt(cy),
      "40",
      this.fmt(r),
    );
  }

  arc(
    layer: string,
    cx: number,
    cy: number,
    r: number,
    startDeg: number,
    endDeg: number,
    ltype?: string,
  ): void {
    this.entities.push(
      "0",
      "ARC",
      "5",
      this.allocHandle(),
      "8",
      layer,
      ...(ltype ? ["6", ltype] : []),
      "10",
      this.fmt(cx),
      "20",
      this.fmt(cy),
      "40",
      this.fmt(r),
      "50",
      this.fmt(startDeg),
      "51",
      this.fmt(endDeg),
    );
  }

  text(layer: string, x: number, y: number, height: number, value: string, rotationDeg = 0): void {
    this.entities.push(
      "0",
      "TEXT",
      "5",
      this.allocHandle(),
      "8",
      layer,
      "10",
      this.fmt(x),
      "20",
      this.fmt(y),
      "40",
      this.fmt(height),
      ...(rotationDeg !== 0 ? ["50", this.fmt(rotationDeg)] : []),
      "1",
      value,
    );
  }

  /** おおよその文字幅を推定して中心合わせで文字を配置する（72/73 依存を避け全環境で位置を安定化）。 */
  textCentered(
    layer: string,
    cx: number,
    cy: number,
    height: number,
    value: string,
    rotationDeg = 0,
  ): void {
    let units = 0;
    for (const ch of value) {
      units += ch.charCodeAt(0) > 0x7f ? 1.0 : 0.6;
    }
    const w = units * height;
    const rad = (rotationDeg * Math.PI) / 180;
    const dx = -w / 2;
    const dy = -height * 0.36;
    const x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    const y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    this.text(layer, x, y, height, value, rotationDeg);
  }

  /** 水平の二重線壁（開口部を切り欠いて端部を閉じる）。 */
  wallH(
    layer: string,
    yCenter: number,
    halfT: number,
    xStart: number,
    xEnd: number,
    openings: SpanOpening[] = [],
  ): void {
    const sorted = [...openings].sort((a, b) => a.start - b.start);
    let cursor = xStart;
    for (const op of sorted) {
      if (op.start > cursor) {
        this.rect(layer, cursor, yCenter - halfT, op.start, yCenter + halfT);
      }
      cursor = Math.max(cursor, op.end);
    }
    if (cursor < xEnd) {
      this.rect(layer, cursor, yCenter - halfT, xEnd, yCenter + halfT);
    }
  }

  /** 垂直の二重線壁（開口部を切り欠いて端部を閉じる）。 */
  wallV(
    layer: string,
    xCenter: number,
    halfT: number,
    yStart: number,
    yEnd: number,
    openings: SpanOpening[] = [],
  ): void {
    const sorted = [...openings].sort((a, b) => a.start - b.start);
    let cursor = yStart;
    for (const op of sorted) {
      if (op.start > cursor) {
        this.rect(layer, xCenter - halfT, cursor, xCenter + halfT, op.start);
      }
      cursor = Math.max(cursor, op.end);
    }
    if (cursor < yEnd) {
      this.rect(layer, xCenter - halfT, cursor, xCenter + halfT, yEnd);
    }
  }

  /** RC 柱（600×600）と斜線ハッチ。 */
  rcColumn(cx: number, cy: number, size = 600): void {
    const h = size / 2;
    this.rect("A-STR-COL", cx - h, cy - h, cx + h, cy + h);
    // 45° コンクリート表現斜線（柱内部に均等配置）
    this.line("A-HATCH", cx - h, cy, cx, cy + h);
    this.line("A-HATCH", cx - h, cy - h, cx + h, cy + h);
    this.line("A-HATCH", cx, cy - h, cx + h, cy);
  }

  /** 水平引き違いアルミサッシ窓（外枠＋障子 2 枚＋建具符号）。 */
  windowH(
    x1: number,
    x2: number,
    yCenter: number,
    halfT: number,
    tag: string,
    tagOffsetY: number,
  ): void {
    const mid = (x1 + x2) / 2;
    // 外枠
    this.line("A-WIND", x1, yCenter - halfT, x2, yCenter - halfT);
    this.line("A-WIND", x1, yCenter + halfT, x2, yCenter + halfT);
    this.rect("A-WIND", x1, yCenter - halfT, x1 + 55, yCenter + halfT);
    this.rect("A-WIND", x2 - 55, yCenter - halfT, x2, yCenter + halfT);
    // 引き違い障子（2 本芯ズレ）
    this.rect("A-WIND", x1 + 55, yCenter + 8, mid + 30, yCenter + 40);
    this.rect("A-WIND", mid - 30, yCenter - 40, x2 - 55, yCenter - 8);
    this.textCentered("A-NOTE", mid, yCenter + tagOffsetY, 150, tag);
  }

  /** 垂直引き違いアルミサッシ窓。 */
  windowV(
    y1: number,
    y2: number,
    xCenter: number,
    halfT: number,
    tag: string,
    tagOffsetX: number,
  ): void {
    const mid = (y1 + y2) / 2;
    this.line("A-WIND", xCenter - halfT, y1, xCenter - halfT, y2);
    this.line("A-WIND", xCenter + halfT, y1, xCenter + halfT, y2);
    this.rect("A-WIND", xCenter - halfT, y1, xCenter + halfT, y1 + 55);
    this.rect("A-WIND", xCenter - halfT, y2 - 55, xCenter + halfT, y2);
    this.rect("A-WIND", xCenter + 8, y1 + 55, xCenter + 40, mid + 30);
    this.rect("A-WIND", xCenter - 40, mid - 30, xCenter - 8, y2 - 55);
    this.textCentered("A-NOTE", xCenter + tagOffsetX, mid, 150, tag, 90);
  }

  /** 片開きドア（扉厚パネル＋90°開き軌跡円弧＋建具符号）。 */
  doorSwing(
    hx: number,
    hy: number,
    width: number,
    openAngleDeg: number,
    arcStartDeg: number,
    arcEndDeg: number,
    tag?: string,
    tagX?: number,
    tagY?: number,
  ): void {
    const rad = (openAngleDeg * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const nx = -uy;
    const ny = ux;
    const leafT = 40;
    const ex = hx + ux * width;
    const ey = hy + uy * width;
    // 扉パネル（厚み 40mm）
    this.line("A-DOOR", hx, hy, ex, ey);
    this.line("A-DOOR", hx + nx * leafT, hy + ny * leafT, ex + nx * leafT, ey + ny * leafT);
    this.line("A-DOOR", hx, hy, hx + nx * leafT, hy + ny * leafT);
    this.line("A-DOOR", ex, ey, ex + nx * leafT, ey + ny * leafT);
    // 開き軌跡円弧
    this.arc("A-DOOR", hx, hy, width, arcStartDeg, arcEndDeg);
    if (tag && tagX !== undefined && tagY !== undefined) {
      this.textCentered("A-NOTE", tagX, tagY, 150, tag);
    }
  }

  /** 水平引き戸（2 枚建）。 */
  doorSlidingH(
    x1: number,
    x2: number,
    yCenter: number,
    halfT: number,
    tag: string,
    tagOffsetY: number,
  ): void {
    const mid = (x1 + x2) / 2;
    // 鴨居・敷居レール
    this.line("A-DOOR", x1, yCenter - halfT + 15, x2, yCenter - halfT + 15);
    this.line("A-DOOR", x1, yCenter + halfT - 15, x2, yCenter + halfT - 15);
    // 障子パネル 2 枚
    this.rect("A-DOOR", x1 + 20, yCenter + 5, mid + 35, yCenter + 38);
    this.rect("A-DOOR", mid - 35, yCenter - 38, x2 - 20, yCenter - 5);
    // 開閉方向小矢印
    this.line("A-DOOR", x1 + 220, yCenter + 130, mid - 120, yCenter + 130);
    this.line("A-DOOR", x1 + 220, yCenter + 130, x1 + 290, yCenter + 165);
    this.line("A-DOOR", mid + 120, yCenter - 130, x2 - 220, yCenter - 130);
    this.line("A-DOOR", x2 - 220, yCenter - 130, x2 - 290, yCenter - 165);
    this.textCentered("A-NOTE", mid, yCenter + tagOffsetY, 150, tag);
  }

  /** 水平寸法線（建築斜めティック＋寸法補助線＋カンマ区切り寸法値）。 */
  dimChainH(
    xs: number[],
    yLine: number,
    yOrigin: number,
    textAbove = true,
    showExtLines = true,
  ): void {
    const tick = 95;
    const extOver = 160;
    const dir = yLine >= yOrigin ? 1 : -1;
    this.line("A-DIM", xs[0] ?? 0, yLine, xs[xs.length - 1] ?? 0, yLine);
    for (let i = 0; i < xs.length; i += 1) {
      const x = xs[i] ?? 0;
      if (showExtLines) {
        this.line("A-DIM", x, yOrigin + dir * 180, x, yLine + dir * extOver);
      }
      this.line("A-DIM", x - tick, yLine - tick, x + tick, yLine + tick);
      if (i > 0) {
        const prev = xs[i - 1] ?? 0;
        const dist = Math.round(Math.abs(x - prev));
        const label = dist.toLocaleString("en-US");
        this.textCentered("A-DIM", (prev + x) / 2, yLine + (textAbove ? 190 : -210), 170, label);
      }
    }
  }

  /** 垂直寸法線（建築斜めティック＋寸法補助線＋90°回転寸法値）。 */
  dimChainV(
    ys: number[],
    xLine: number,
    xOrigin: number,
    textLeft = true,
    showExtLines = true,
  ): void {
    const tick = 95;
    const extOver = 160;
    const dir = xLine >= xOrigin ? 1 : -1;
    this.line("A-DIM", xLine, ys[0] ?? 0, xLine, ys[ys.length - 1] ?? 0);
    for (let i = 0; i < ys.length; i += 1) {
      const y = ys[i] ?? 0;
      if (showExtLines) {
        this.line("A-DIM", xOrigin + dir * 180, y, xLine + dir * extOver, y);
      }
      this.line("A-DIM", xLine - tick, y - tick, xLine + tick, y + tick);
      if (i > 0) {
        const prev = ys[i - 1] ?? 0;
        const dist = Math.round(Math.abs(y - prev));
        const label = dist.toLocaleString("en-US");
        this.textCentered("A-DIM", xLine + (textLeft ? -210 : 210), (prev + y) / 2, 170, label, 90);
      }
    }
  }

  /** 執務デスク 1 席分（天板＋モニター＋オフィスチェア）。 */
  officeWorkstation(
    x: number,
    y: number,
    w: number,
    d: number,
    chairSide: "north" | "south",
  ): void {
    this.rect("A-FURN", x, y, x + w, y + d);
    // PC モニター表現
    const mx = x + w / 2;
    const my = chairSide === "south" ? y + d - 130 : y + 130;
    this.rect("A-FURN", mx - 220, my - 30, mx + 220, my + 30);
    // チェア（座面＋背もたれ）
    const cy = chairSide === "south" ? y - 270 : y + d + 270;
    this.rect("A-FURN", mx - 210, cy - 190, mx + 210, cy + 190);
    if (chairSide === "south") {
      this.rect("A-FURN", mx - 210, cy - 250, mx + 210, cy - 190);
    } else {
      this.rect("A-FURN", mx - 210, cy + 190, mx + 210, cy + 250);
    }
  }

  /** 洋式大便器シンボル（タンク＋便座）。 */
  toiletFixture(cx: number, cy: number, facing: "west" | "east"): void {
    const dir = facing === "west" ? -1 : 1;
    // ロータンク
    const tankX1 = facing === "west" ? cx + 190 : cx - 370;
    const tankX2 = facing === "west" ? cx + 370 : cx - 190;
    this.rect("A-EQUIP", tankX1, cy - 210, tankX2, cy + 210);
    // 便器本体（楕円近似：円＋接続矩形）
    this.circle("A-EQUIP", cx + dir * 30, cy, 175);
    this.circle("A-EQUIP", cx + dir * 45, cy, 115);
    if (facing === "west") {
      this.line("A-EQUIP", cx + 60, cy - 170, cx + 190, cy - 170);
      this.line("A-EQUIP", cx + 60, cy + 170, cx + 190, cy + 170);
    } else {
      this.line("A-EQUIP", cx - 190, cy - 170, cx - 60, cy - 170);
      this.line("A-EQUIP", cx - 190, cy + 170, cx - 60, cy + 170);
    }
  }

  /** 方位記号（真北マーク）。 */
  northArrow(cx: number, cy: number, r: number): void {
    this.circle("A-SYMB", cx, cy, r);
    this.circle("A-SYMB", cx, cy, r * 0.84);
    this.line("A-SYMB", cx - r * 1.15, cy, cx + r * 1.15, cy);
    this.line("A-SYMB", cx, cy - r * 1.15, cx, cy + r * 1.25);
    // 北針三角
    this.line("A-SYMB", cx, cy + r * 0.84, cx - r * 0.24, cy);
    this.line("A-SYMB", cx, cy + r * 0.84, cx + r * 0.24, cy);
    this.line("A-SYMB", cx - r * 0.24, cy, cx + r * 0.24, cy);
    this.textCentered("A-SYMB", cx, cy + r * 1.55, 240, "N");
  }

  build(): Uint8Array {
    const handseed = (this.nextHandle + 0x100).toString(16).toUpperCase();
    const layers: Array<[string, string, number, string]> = [
      ["10", "0", 7, "CONTINUOUS"],
      ["11", "A-GRID", 1, "CENTER"],
      ["12", "A-STR-COL", 7, "CONTINUOUS"],
      ["13", "A-WALL-EXT", 7, "CONTINUOUS"],
      ["14", "A-WALL-INT", 7, "CONTINUOUS"],
      ["15", "A-DOOR", 3, "CONTINUOUS"],
      ["16", "A-WIND", 3, "CONTINUOUS"],
      ["17", "A-STAIR", 7, "CONTINUOUS"],
      ["18", "A-EQUIP", 3, "CONTINUOUS"],
      ["19", "A-FURN", 8, "CONTINUOUS"],
      ["1A", "A-HATCH", 8, "CONTINUOUS"],
      ["1B", "A-DIM", 4, "CONTINUOUS"],
      ["1C", "A-NOTE", 5, "CONTINUOUS"],
      ["1D", "A-SYMB", 1, "CONTINUOUS"],
      ["1E", "A-FRAME", 7, "CONTINUOUS"],
    ];

    const headerAndTables: string[] = [
      "0",
      "SECTION",
      "2",
      "HEADER",
      "9",
      "$ACADVER",
      "1",
      "AC1021",
      "9",
      "$INSUNITS",
      "70",
      "4",
      "9",
      "$HANDSEED",
      "5",
      handseed,
      "0",
      "ENDSEC",
      "0",
      "SECTION",
      "2",
      "TABLES",
      "0",
      "TABLE",
      "2",
      "LTYPE",
      "70",
      "3",
      // CONTINUOUS
      "0",
      "LTYPE",
      "5",
      "20",
      "2",
      "CONTINUOUS",
      "70",
      "0",
      "3",
      "Solid line",
      "72",
      "65",
      "73",
      "0",
      "40",
      "0.0",
      // CENTER（一点鎖線）
      "0",
      "LTYPE",
      "5",
      "21",
      "2",
      "CENTER",
      "70",
      "0",
      "3",
      "Center line",
      "72",
      "65",
      "73",
      "4",
      "40",
      "370.0",
      "49",
      "240.0",
      "49",
      "-40.0",
      "49",
      "50.0",
      "49",
      "-40.0",
      // DASHED（破線）
      "0",
      "LTYPE",
      "5",
      "22",
      "2",
      "DASHED",
      "70",
      "0",
      "3",
      "Dashed line",
      "72",
      "65",
      "73",
      "2",
      "40",
      "240.0",
      "49",
      "160.0",
      "49",
      "-80.0",
      "0",
      "ENDTAB",
      "0",
      "TABLE",
      "2",
      "LAYER",
      "70",
      String(layers.length),
      ...layers.flatMap(([handle, name, color, ltype]) => [
        "0",
        "LAYER",
        "5",
        handle,
        "2",
        name,
        "70",
        "0",
        "62",
        String(color),
        "6",
        ltype,
      ]),
      "0",
      "ENDTAB",
      "0",
      "ENDSEC",
      "0",
      "SECTION",
      "2",
      "ENTITIES",
    ];

    const full = [...headerAndTables, ...this.entities, "0", "ENDSEC", "0", "EOF", ""];
    return new TextEncoder().encode(full.join("\n"));
  }
}

/**
 * 現実の小規模 RC 造オフィスビル 1 階平面図（S=1/100）の合成 DXF（AC1021 / UTF-8）を返す。
 */
export function buildSamplePlanDxf(): Uint8Array {
  const d = new DxfBuilder();

  const xs = [0, 5400, 10200, 14400];
  const ys = [0, 4800, 9600];
  const xLabels = ["X1", "X2", "X3", "X4"];
  const yLabels = ["Y1", "Y2", "Y3"];

  // =========================================================================
  // 1. 図面枠・表題欄・特記仕様・方位記号
  // =========================================================================
  d.rect("A-FRAME", -3900, -4450, 18500, 13650);
  d.rect("A-FRAME", -3650, -4200, 18250, 13400);

  // 表題欄（右下）
  const tbX1 = 10750;
  const tbX2 = 18250;
  const tbY1 = -4200;
  const tbY2 = -2200;
  d.rect("A-FRAME", tbX1, tbY1, tbX2, tbY2);
  // 横仕切線（4 行）
  d.line("A-FRAME", tbX1, -2680, tbX2, -2680);
  d.line("A-FRAME", tbX1, -3220, tbX2, -3220);
  d.line("A-FRAME", tbX1, -3710, tbX2, -3710);
  // 縦仕切線
  d.line("A-FRAME", tbX1 + 1300, tbY1, tbX1 + 1300, tbY2); // 見出し列
  d.line("A-FRAME", 16000, -3710, 16000, -2680); // 縮尺・図番の左線
  d.line("A-FRAME", 16850, -3710, 16850, -2680); // 縮尺・図番の値列
  d.line("A-FRAME", 13650, tbY1, 13650, -3710); // 設計
  d.line("A-FRAME", 15180, tbY1, 15180, -3710); // 照査
  d.line("A-FRAME", 16710, tbY1, 16710, -3710); // 承認

  // 表題欄文字
  d.textCentered("A-NOTE", tbX1 + 650, -2440, 185, "工事名称");
  d.text("A-NOTE", tbX1 + 1500, -2530, 215, "（仮称）神田オフィスビル新築工事");
  d.textCentered("A-NOTE", tbX1 + 650, -2950, 185, "図面名称");
  d.text("A-NOTE", tbX1 + 1500, -3075, 290, "1階平面図");
  d.textCentered("A-NOTE", 16425, -2950, 175, "縮尺");
  d.textCentered("A-NOTE", 17550, -2950, 200, "S=1/100");
  d.textCentered("A-NOTE", tbX1 + 650, -3465, 175, "構造・規模");
  d.text("A-NOTE", tbX1 + 1500, -3545, 180, "RC造 地上3階建（1F 基準階高 3,400）");
  d.textCentered("A-NOTE", 16425, -3465, 175, "図番");
  d.textCentered("A-NOTE", 17550, -3465, 225, "A-01");
  d.textCentered("A-NOTE", tbX1 + 650, -3955, 175, "作成年月");
  d.textCentered("A-NOTE", 12850, -3955, 185, "2026.11");
  d.textCentered("A-NOTE", 14415, -3955, 165, "設計");
  d.textCentered("A-NOTE", 15945, -3955, 165, "照査");
  d.textCentered("A-NOTE", 17480, -3955, 165, "承認");

  // 左下：特記仕様メモ枠
  d.rect("A-FRAME", -3350, -4000, 6100, -2550);
  d.text("A-NOTE", -3120, -2860, 190, "【特記仕様】 単位: mm ／ 1FL = GL+150 ／ 階高 = 3,400");
  d.text("A-NOTE", -3120, -3180, 165, "・外壁: RC造 t=180（打放し補修の上、複層塗材E）");
  d.text("A-NOTE", -3120, -3480, 165, "・間仕切: LGS-65 + PB12.5 両面張（壁厚 t=120）");
  d.text("A-NOTE", -3120, -3780, 165, "・仕上・建具の詳細は「仕上表・建具表.csv」を参照");

  // 方位記号（右上）
  d.northArrow(17050, 12050, 480);

  // =========================================================================
  // 2. 通り芯（A-GRID）と通り芯バルーン
  // =========================================================================
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] ?? 0;
    d.line("A-GRID", x, -1920, x, 12340);
    d.circle("A-GRID", x, 12700, 360);
    d.textCentered("A-GRID", x, 12700, 230, xLabels[i] ?? "");
  }
  for (let i = 0; i < ys.length; i += 1) {
    const y = ys[i] ?? 0;
    d.line("A-GRID", -2690, y, 15600, y);
    d.circle("A-GRID", -3050, y, 360);
    d.textCentered("A-GRID", -3050, y, 230, yLabels[i] ?? "");
  }

  // =========================================================================
  // 3. RC 構造柱（12 本：600×600）
  // =========================================================================
  for (const x of xs) {
    for (const y of ys) {
      d.rcColumn(x, y, 600);
    }
  }

  // =========================================================================
  // 4. RC 外壁（t=180）と外周建具（サッシ窓・両開き玄関扉・庇・ポーチ）
  // =========================================================================
  const extHalf = 90;

  // 南外壁（Y = 0）
  d.wallH("A-WALL-EXT", 0, extHalf, 300, 5100, [{ start: 1100, end: 4300 }]);
  d.windowH(1100, 4300, 0, extHalf, "AW-01", -280);

  d.wallH("A-WALL-EXT", 0, extHalf, 5700, 9900, [{ start: 6400, end: 9200 }]);
  d.windowH(6400, 9200, 0, extHalf, "AW-02", -280);

  d.wallH("A-WALL-EXT", 0, extHalf, 10500, 14100, [{ start: 11400, end: 13200 }]);
  // 両開き玄関扉 SD-01（W=1,800: 900+900 外開き）
  d.doorSwing(11400, -90, 900, 270, 270, 360);
  d.doorSwing(13200, -90, 900, 270, 180, 270);
  d.textCentered("A-NOTE", 12300, -450, 160, "SD-01");
  // 玄関ポーチ段差・庇（破線）・アプローチ矢印
  d.rect("A-HATCH", 10700, -1080, 13900, -90);
  d.line("A-HATCH", 10700, -820, 13900, -820);
  d.rect("A-SYMB", 10500, -1250, 14100, -90, "DASHED");
  d.line("A-SYMB", 12300, -1520, 12300, -1100);
  d.line("A-SYMB", 12300, -1100, 12180, -1240);
  d.line("A-SYMB", 12300, -1100, 12420, -1240);
  d.textCentered("A-NOTE", 12650, -1350, 150, "IN");

  // 北外壁（Y = 9600）
  d.wallH("A-WALL-EXT", 9600, extHalf, 300, 5100, [{ start: 1200, end: 4200 }]);
  d.windowH(1200, 4200, 9600, extHalf, "AW-03", 280);

  d.wallH("A-WALL-EXT", 9600, extHalf, 5700, 9900, [
    { start: 6200, end: 8000 },
    { start: 8700, end: 9500 },
  ]);
  d.windowH(6200, 8000, 9600, extHalf, "AW-04", 280);
  d.windowH(8700, 9500, 9600, extHalf, "AW-05", 280);

  d.wallH("A-WALL-EXT", 9600, extHalf, 10500, 14100, [{ start: 11800, end: 13400 }]);
  d.windowH(11800, 13400, 9600, extHalf, "AW-06", 280);

  // 西外壁（X = 0）
  d.wallV("A-WALL-EXT", 0, extHalf, 300, 4500, [{ start: 1200, end: 3600 }]);
  d.windowV(1200, 3600, 0, extHalf, "AW-07", -280);

  d.wallV("A-WALL-EXT", 0, extHalf, 5100, 9300, [{ start: 6000, end: 8400 }]);
  d.windowV(6000, 8400, 0, extHalf, "AW-08", -280);

  // 東外壁（X = 14400）
  d.wallV("A-WALL-EXT", 14400, extHalf, 300, 4500, [{ start: 1200, end: 3000 }]);
  d.windowV(1200, 3000, 14400, extHalf, "AW-09", 280);
  // 北東側は階段室・WC 耐火無窓壁
  d.wallV("A-WALL-EXT", 14400, extHalf, 5100, 9300);

  // =========================================================================
  // 5. 間仕切り壁（t=120）と内部建具
  // =========================================================================
  const intHalf = 60;

  // 東西中央間仕切（Y = 4800）
  // 執務室 ↔ 会議室A（扉 WD-01: W=900）
  d.wallH("A-WALL-INT", 4800, intHalf, 300, 5100, [{ start: 3800, end: 4700 }]);
  d.doorSwing(3800, 4860, 900, 90, 0, 90, "WD-01", 4350, 4520);

  // 執務室 ↔ 応接室（ガラス引き戸 WD-02: W=1,600）・給湯室（扉 WD-03: W=800）
  d.wallH("A-WALL-INT", 4800, intHalf, 5700, 9900, [
    { start: 6100, end: 7700 },
    { start: 8800, end: 9600 },
  ]);
  d.doorSlidingH(6100, 7700, 4800, intHalf, "WD-02", -280);
  d.doorSwing(8800, 4860, 800, 90, 0, 90, "WD-03", 9250, 4520);

  // エントランス ↔ 階段・WC ホール（X=10500..11700 は開放通路、東側を階段壁で仕切）
  d.wallH("A-WALL-INT", 4800, intHalf, 11700, 14100);

  // 南北間仕切
  // X = 5400（会議室A ↔ 応接室）
  d.wallV("A-WALL-INT", 5400, intHalf, 5100, 9300);
  // X = 8400（応接室 ↔ 給湯室）
  d.wallV("A-WALL-INT", 8400, intHalf, 4860, 9510);
  // X = 10200 南（執務室 ↔ エントランス、扉 WD-04: W=1,000）
  d.wallV("A-WALL-INT", 10200, intHalf, 300, 4500, [{ start: 1600, end: 2600 }]);
  d.doorSwing(10140, 2600, 1000, 180, 180, 270, "WD-04", 10550, 2100);
  // X = 10200 北（給湯室 ↔ コアホール・PS/EPS）
  d.wallV("A-WALL-INT", 10200, intHalf, 5100, 9300);

  // WC・PS/EPS 区画壁（Y = 7400, X = 11200）
  d.wallH("A-WALL-INT", 7400, intHalf, 10260, 14310, [{ start: 11500, end: 12250 }]);
  d.doorSwing(11500, 7460, 750, 90, 0, 90, "WD-05", 11900, 7120);
  // PS / EPS 区画（X = 10260..11200, Y = 7460..9510）
  d.wallV("A-WALL-INT", 11200, 50, 7460, 9510);
  d.line("A-WALL-INT", 10260, 8485, 11150, 8485);
  // PS 対角×印
  d.line("A-HATCH", 10260, 8485, 11150, 9510);
  d.line("A-HATCH", 10260, 9510, 11150, 8485);
  d.textCentered("A-NOTE", 10705, 8995, 160, "PS");
  // EPS 対角×印
  d.line("A-HATCH", 10260, 7460, 11150, 8485);
  d.line("A-HATCH", 10260, 8485, 11150, 7460);
  d.textCentered("A-NOTE", 10705, 7970, 160, "EPS");

  // =========================================================================
  // 6. 階段室（折り返し階段：X=11700..14310, Y=4860..7340）
  // =========================================================================
  // 階段外周・踊り場・吹抜隙間
  d.rect("A-STAIR", 11700, 4860, 14310, 7340);
  // 階段中間手摺壁（隙間の表現）
  d.rect("A-STAIR", 11700, 6020, 13450, 6180);
  // 踊り場境界線
  d.line("A-STAIR", 13450, 4860, 13450, 7340);
  // 踏面（南側下段 7 ステップ：250mm ピッチ）
  for (let i = 1; i <= 6; i += 1) {
    const tx = 11700 + i * 250;
    d.line("A-STAIR", tx, 4860, tx, 6020);
  }
  // 踏面（北側上段：切断斜線の右側まで描画）
  for (let i = 1; i <= 6; i += 1) {
    const tx = 11700 + i * 250;
    d.line("A-STAIR", tx, 6180, tx, 7340);
  }
  // 上段の切断表現斜線
  d.line("A-STAIR", 12250, 6180, 12750, 7340);
  d.line("A-STAIR", 12350, 6180, 12850, 7340);
  // 昇り方向矢印（UP）
  d.line("A-STAIR", 11850, 5440, 13880, 5440);
  d.line("A-STAIR", 13880, 5440, 13880, 6760);
  d.line("A-STAIR", 13880, 6760, 12950, 6760);
  d.line("A-STAIR", 12950, 6760, 13120, 6870);
  d.line("A-STAIR", 12950, 6760, 13120, 6650);
  d.circle("A-STAIR", 11850, 5440, 65);
  d.textCentered("A-NOTE", 12350, 5650, 155, "UP");

  // =========================================================================
  // 7. WC 衛生設備（ブース 2 室＋洗面カウンター）
  // =========================================================================
  // 大便器ブース仕切（X = 12850, Y = 8485）
  d.line("A-WALL-INT", 12850, 7460, 12850, 7650);
  d.line("A-WALL-INT", 12850, 8250, 12850, 8680);
  d.line("A-WALL-INT", 12850, 9280, 12850, 9510);
  d.line("A-WALL-INT", 12850, 8485, 14310, 8485);
  // ブース内開き戸（W=600）
  d.doorSwing(12850, 7650, 600, 0, 0, 90);
  d.doorSwing(12850, 8680, 600, 0, 0, 90);
  // 大便器 2 基
  d.toiletFixture(13900, 7970, "west");
  d.toiletFixture(13900, 8995, "west");
  // 手洗いカウンター（北壁側）
  d.rect("A-EQUIP", 11300, 8950, 12650, 9510);
  d.circle("A-EQUIP", 11700, 9230, 170);
  d.circle("A-EQUIP", 12280, 9230, 170);
  d.circle("A-EQUIP", 11700, 9230, 35);
  d.circle("A-EQUIP", 12280, 9230, 35);

  // =========================================================================
  // 8. 給湯室設備（シンク・2口 IH・冷蔵庫）
  // =========================================================================
  d.rect("A-EQUIP", 8500, 8860, 10100, 9510);
  // シンク
  d.rect("A-EQUIP", 8600, 8950, 9220, 9420);
  d.circle("A-EQUIP", 8910, 9185, 55);
  // 2 口 IH コンロ
  d.rect("A-EQUIP", 9420, 8960, 9980, 9410);
  d.circle("A-EQUIP", 9600, 9185, 95);
  d.circle("A-EQUIP", 9830, 9185, 75);
  // 冷蔵庫
  d.rect("A-EQUIP", 8520, 7750, 9180, 8450);
  d.line("A-HATCH", 8520, 7750, 9180, 8450);
  d.line("A-HATCH", 8520, 8450, 9180, 7750);
  d.textCentered("A-NOTE", 8850, 7540, 145, "REF");

  // =========================================================================
  // 9. 家具・什器（執務室・会議室A・応接室・エントランス）
  // =========================================================================
  // 執務室：デスク島 1（3席×2列 = 6席）
  for (let col = 0; col < 3; col += 1) {
    const dx = 1350 + col * 1200;
    d.officeWorkstation(dx, 1450, 1200, 700, "south");
    d.officeWorkstation(dx, 2150, 1200, 700, "north");
  }
  // 執務室：デスク島 2（2席×2列 = 4席）
  for (let col = 0; col < 2; col += 1) {
    const dx = 5950 + col * 1200;
    d.officeWorkstation(dx, 1450, 1200, 700, "south");
    d.officeWorkstation(dx, 2150, 1200, 700, "north");
  }
  // 執務室：壁面キャビネット＆複合機（MFP）
  d.rect("A-FURN", 160, 3650, 620, 4650);
  d.line("A-FURN", 160, 4150, 620, 4150);
  d.rect("A-FURN", 8950, 3750, 9750, 4450);
  d.textCentered("A-NOTE", 9350, 4100, 140, "MFP");

  // 会議室A：大型会議テーブル（2,800×1,300）＋椅子 8 脚＋大型ディスプレイ
  d.rect("A-FURN", 1300, 6550, 4100, 7850);
  for (let i = 0; i < 3; i += 1) {
    const cx = 1800 + i * 900;
    d.rect("A-FURN", cx - 210, 6100, cx + 210, 6460);
    d.rect("A-FURN", cx - 210, 7940, cx + 210, 8300);
  }
  d.rect("A-FURN", 840, 6990, 1200, 7410);
  d.rect("A-FURN", 4200, 6990, 4560, 7410);
  // 西壁側ホワイトボード／大型モニター
  d.rect("A-EQUIP", 140, 6400, 260, 8000);

  // 応接室：円形打合せテーブル（CIRCLE / A-EQUIP）＋チェア 4 脚
  d.circle("A-EQUIP", 6900, 7100, 580);
  const chairAngles = [45, 135, 225, 315];
  for (const deg of chairAngles) {
    const rad = (deg * Math.PI) / 180;
    const cx = 6900 + Math.cos(rad) * 860;
    const cy = 7100 + Math.sin(rad) * 860;
    d.rect("A-FURN", cx - 190, cy - 190, cx + 190, cy + 190);
  }

  // エントランス：受付カウンター＋待合ベンチ＋床見切（FL-50 / FL±0）
  d.rect("A-FURN", 10650, 3250, 12550, 3850);
  d.textCentered("A-NOTE", 11600, 3550, 165, "受付");
  d.rect("A-FURN", 13500, 1300, 14120, 2900);
  // 風除・土間見切線
  d.line("A-HATCH", 10260, 1200, 13450, 1200);

  // =========================================================================
  // 10. 室名・床レベル・面積ラベル（A-NOTE）
  // =========================================================================
  d.textCentered("A-NOTE", 3150, 4050, 240, "執務室");
  d.textCentered("A-NOTE", 3150, 3680, 155, "FL±0  54.0m²");

  d.textCentered("A-NOTE", 2700, 9020, 220, "会議室A");
  d.textCentered("A-NOTE", 2700, 8680, 150, "FL±0  25.9m²");

  d.textCentered("A-NOTE", 6900, 9020, 210, "応接室");
  d.textCentered("A-NOTE", 6900, 8680, 150, "FL±0  14.4m²");

  d.textCentered("A-NOTE", 9300, 6820, 190, "給湯室");
  d.textCentered("A-NOTE", 9300, 6500, 145, "FL±0  8.6m²");

  d.textCentered("A-NOTE", 11850, 2150, 210, "エントランス");
  d.textCentered("A-NOTE", 11850, 1810, 150, "FL-50  18.0m²");

  d.textCentered("A-NOTE", 10960, 6220, 175, "ホール");
  d.textCentered("A-NOTE", 12000, 8450, 190, "WC");

  // =========================================================================
  // 11. 断面切断記号（A - A'）
  // =========================================================================
  // 上側（北）
  d.line("A-SYMB", 2700, 9850, 2700, 10250);
  d.line("A-SYMB", 2700, 10250, 3150, 10250);
  d.line("A-SYMB", 3150, 10250, 2970, 10360);
  d.line("A-SYMB", 3150, 10250, 2970, 10140);
  d.textCentered("A-SYMB", 3360, 10250, 210, "A");
  // 下側（南）
  d.line("A-SYMB", 2700, -250, 2700, -650);
  d.line("A-SYMB", 2700, -650, 3150, -650);
  d.line("A-SYMB", 3150, -650, 2970, -540);
  d.line("A-SYMB", 3150, -650, 2970, -760);
  d.textCentered("A-SYMB", 3390, -650, 210, "A'");

  // =========================================================================
  // 12. 3 段構成の寸法線（A-DIM）
  // =========================================================================
  // 北側（3 段：主要開口/間仕切芯・スパン・全長）
  d.dimChainH([0, 1200, 4200, 5400, 8400, 10200, 11800, 13400, 14400], 10620, 9690);
  d.dimChainH([0, 5400, 10200, 14400], 11300, 9690, true, false);
  d.dimChainH([0, 14400], 11960, 9690, true, false);

  // 西側（3 段：開口・スパン・全長）
  d.dimChainV([0, 1200, 3600, 4800, 6000, 8400, 9600], -860, -90);
  d.dimChainV([0, 4800, 9600], -1540, -90, true, false);
  d.dimChainV([0, 9600], -2200, -90, true, false);

  // 南側（スパン寸法：玄関庇・IN 矢印と重ならない位置に配置）
  d.dimChainH([0, 5400, 10200, 14400], -1720, -90, false, true);

  return d.build();
}

/** 平面図と対になる実務想定の仕上表・建具表 CSV。 */
export function buildSampleScheduleCsv(): Uint8Array {
  const rows = [
    "区分,符号/室名,位置/レベル,面積/寸法(mm),床/材質,壁/ガラス仕様,天井/備考",
    "内部仕上,執務室,1F / FL±0,54.0 m2,OAフロア50+タイルカーペット,PB12.5の上EP塗,システム天井(岩綿吸音板)",
    "内部仕上,会議室A,1F / FL±0,25.9 m2,OAフロア50+タイルカーペット,PB12.5の上ビニルクロス(遮音),システム天井(岩綿吸音板)",
    "内部仕上,応接室,1F / FL±0,14.4 m2,タイルカーペット,PB12.5の上ビニルクロス,PB9.5の上EP塗",
    "内部仕上,給湯室,1F / FL±0,8.6 m2,長尺塩ビシート,キッチンパネル+EP塗,PB9.5の上EP塗",
    "内部仕上,エントランス,1F / FL-50,18.0 m2,磁器質タイル300角(防滑),RC打放し補修の上撥水材,アルミルーバー天井",
    "内部仕上,WC,1F / FL±0,7.2 m2,長尺塩ビシート,磁器質タイル+EP塗,PB9.5の上EP塗(耐水)",
    "内部仕上,階段室,1F / FL±0,-,ノンスリップ長尺シート,RC打放しの上EP塗,直天井EP塗",
    "建具表,SD-01,南外壁(エントランス),W1800 x H2300,アルミ強化ガラス両開き戸,強化ガラスt=10,電気錠・ドアクローザー付",
    "建具表,WD-01,執務室-会議室A,W900 x H2100,木製フラッシュ片開き戸,スリットガラス付,遮音パッキン仕様",
    "建具表,WD-02,執務室-応接室,W1600 x H2100,アルミ枠ガラス2枚引き戸,飛散防止フィルム貼,ソフトクローズ機構",
    "建具表,WD-03,執務室-給湯室,W800 x H2100,木製フラッシュ片開き戸,パネル戸,アンダーカット15mm",
    "建具表,WD-04,執務室-エントランス,W1000 x H2100,スチール枠ガラス片開き戸,強化ガラスt=8,カードリーダー連動",
    "建具表,WD-05,ホール-WC,W750 x H2100,木製フラッシュ片開き戸,表示錠・ガラリ付,幅750mm(バリアフリー要再確認)",
    "建具表,AW-01,南外壁(X1-X2),W3200 x H2000,アルミサッシ引き違い連窓,Low-E複層ガラス,網戸付",
    "建具表,AW-02,南外壁(X2-X3),W2800 x H2000,アルミサッシ引き違い連窓,Low-E複層ガラス,網戸付",
    "建具表,AW-03,北外壁(X1-X2),W3000 x H1800,アルミサッシ引き違い連窓,Low-E複層ガラス,ロールスクリーン下地",
    "建具表,AW-04,北外壁(応接室),W1800 x H1800,アルミサッシ引き違い窓,Low-E複層ガラス,-",
    "建具表,AW-05,北外壁(給湯室),W800 x H1100,アルミサッシすべり出し窓,型板複層ガラス,換気用高窓",
    "建具表,AW-06,北外壁(WC),W1600 x H900,アルミサッシ高窓,型板複層ガラス,排煙・換気兼用",
    "建具表,AW-07,西外壁(執務室),W2400 x H2000,アルミサッシ引き違い窓,Low-E複層ガラス,西日遮熱タイプ",
    "建具表,AW-08,西外壁(会議室A),W2400 x H1800,アルミサッシ引き違い窓,Low-E複層ガラス,西日遮熱タイプ",
    "建具表,AW-09,東外壁(エントランス),W1800 x H2000,アルミFIX窓,強化複層ガラス,採光用",
  ];
  return new TextEncoder().encode(`\uFEFF${rows.join("\r\n")}\r\n`);
}

/** 設計打合せメモ・チェック前確認事項（Markdown）。 */
export function buildSampleDesignNotesMd(): Uint8Array {
  const md = `# （仮称）神田オフィスビル新築工事 — 1階平面図 確認メモ

対象図面: \`A-01_1F平面図.dxf\`（S=1/100）
関連資料: \`仕上表・建具表.csv\`

## 今回の確認・修正予定事項

1. **応接室の円形テーブル位置調整**
   - 応接室（X2〜X3 間・北側）の円形テーブル（\`A-EQUIP\` レイヤ）を、引き戸 \`WD-02\` からの動線確保のため東側（X+350mm 程度）へ寄せる案を検討中。
2. **トイレ入口 \`WD-05\` の有効開口幅**
   - 現行 W=750mm となっているが、車椅子・バリアフリー対応として W=800〜850mm へ拡幅できるか建具表と合わせて確認する。
3. **CAD 製図基準（電子納品）チェック前の確認**
   - 現行レイヤは社内建築略称（\`A-WALL-EXT\`・\`A-GRID\`・\`A-DIM\` 等）で作成済み。
   - 国土交通省 CAD 製図基準プロファイルで照合し、納品時に読み替えが必要なレイヤ名・ファイル名を洗い出す。
4. **執務室〜エントランスのセキュリティ動線**
   - \`WD-04\`（W=1,000）をカードリーダー連動とし、来客は受付から応接室・会議室Aへ誘導する想定。
`;
  return new TextEncoder().encode(md);
}

/** サンプルワークスペース一式を返す。 */
export function buildSampleWorkspaceFiles(): Record<string, Uint8Array> {
  return {
    [SAMPLE_DRAWING_PATH]: buildSamplePlanDxf(),
    [SAMPLE_SCHEDULE_PATH]: buildSampleScheduleCsv(),
    [SAMPLE_NOTES_PATH]: buildSampleDesignNotesMd(),
  };
}
