import SettingsManager from "./settingsManager";
import Template from "./Template";
import {
  base64ToUint8,
  colorpaletteForBlueMarble,
  consoleError,
  consoleLog,
  consoleWarn,
  localizeNumber,
  numberToEncoded,
  sleep,
  viewCanvasInNewTab
} from "./utils";
import WindowMain from "./WindowMain";
import WindowWizard from "./WindowWizard";

export default class TemplateManager {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.windowMain = null;
    this.settingsManager = null;
    this.schemaVersion = "2.0.0";
    this.userID = null;
    this.encodingBase =
      "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
    this.tileSize = 1000;
    this.drawMult = 3;
    this.paletteTolerance = 3;
    this.paletteBM = colorpaletteForBlueMarble(this.paletteTolerance);

    this.template = null;
    this.templateState = "";
    this.templatesArray = [];
    this.templatesJSON = null;
    this.templatesShouldBeDrawn = true;
    this.templatePixelsCorrect = null;
    // Load saved color visibility (hidden color IDs) from storage
    this.shouldFilterColor = (() => {
      try {
        const saved = JSON.parse(GM_getValue('bmFilterColors', '[]'));
        return new Map(saved.map(id => [id, true]));
      } catch { return new Map(); }
    })();

    this._tileIndexDirty = true;
    this._tileIndex = new Map();

    this._tileCanvas = null;
    this._tileContext = null;

    this._analysisCanvas = null;
    this._analysisContext = null;

    this.xModeEnabled = false;

    this.xBgIndex = 0;
    this.xBgPresets = [
      { css: "rgb(69,81,110)", u32: 0xff6e5145 >>> 0 },
      { css: "rgb(255,255,255)", u32: 0xffffffff >>> 0 }
    ];
  }

  setWindowMain(windowMain) {
    this.windowMain = windowMain;
  }

  setSettingsManager(settingsManager) {
    this.settingsManager = settingsManager;
  }

  toggleXMode() {
    this.xModeEnabled = !this.xModeEnabled;
    if (this.xModeEnabled) this.xBgIndex = 0;
    return this.xModeEnabled;
  }

  toggleXBackground() {
    if (!this.xModeEnabled) return null;
    this.xBgIndex = (this.xBgIndex + 1) % this.xBgPresets.length;
    return this.xBgPresets[this.xBgIndex];
  }

  _getXBackground() {
    return this.xBgPresets[this.xBgIndex] || this.xBgPresets[0];
  }

  _ensureTileCanvas() {
    const drawSize = this.tileSize * this.drawMult;
    if (!this._tileCanvas) {
      this._tileCanvas = new OffscreenCanvas(drawSize, drawSize);
      this._tileContext = this._tileCanvas.getContext("2d", { willReadFrequently: true });
      this._tileContext.imageSmoothingEnabled = false;
    }
  }

  _ensureAnalysisCanvas() {
    const drawSize = this.tileSize * this.drawMult;
    if (!this._analysisCanvas) {
      this._analysisCanvas = new OffscreenCanvas(drawSize, drawSize);
      this._analysisContext = this._analysisCanvas.getContext("2d", { willReadFrequently: true });
      this._analysisContext.imageSmoothingEnabled = false;
    }
  }

  _rebuildTileIndex() {
    this._tileIndex.clear();

    for (const template of this.templatesArray) {
      if (!template?.chunked) continue;
      for (const tileKey of Object.keys(template.chunked)) {
        const tileCoordsKey = tileKey.slice(0, 9);
        let arr = this._tileIndex.get(tileCoordsKey);
        if (!arr) {
          arr = [];
          this._tileIndex.set(tileCoordsKey, arr);
        }
        arr.push({ template, tileKey });
      }
    }

    for (const arr of this._tileIndex.values()) {
      arr.sort((a, b) => (a.template.sortID ?? 0) - (b.template.sortID ?? 0));
    }

    this._tileIndexDirty = false;
  }

  async createJSON() {
    return {
      whoami: this.name.replaceAll(" ", ""),
      scriptVersion: this.version,
      schemaVersion: this.schemaVersion,
      templates: {}
    };
  }

  async createTemplate(blob, name, coords) {
    if (!this.templatesJSON) this.templatesJSON = await this.createJSON();

    this.windowMain.handleDisplayStatus(`Creating template at ${coords.join(", ")}...`);

    const template = new Template({
      displayName: name,
      sortID: 0,
      authorID: numberToEncoded(this.userID || 0, this.encodingBase),
      file: blob,
      coords: coords
    });

    const shouldSkipTransTiles = !this.settingsManager?.userSettings?.flags?.includes("hl-noSkip");
    const shouldAggSkipTransTiles = this.settingsManager?.userSettings?.flags?.includes("hl-agSkip");

    const { templateTiles, templateTilesBuffers } = await template.createTemplateTiles(
      this.tileSize,
      this.paletteBM,
      shouldSkipTransTiles,
      shouldAggSkipTransTiles
    );

    template.chunked = templateTiles;

    const _pixels = { total: template.pixelCount.total, colors: Object.fromEntries(template.pixelCount.colors) };

    this.templatesJSON.templates[`${template.sortID} ${template.authorID}`] = {
      name: template.displayName,
      coords: coords.join(", "),
      enabled: true,
      pixels: _pixels,
      tiles: templateTilesBuffers
    };

    this.templatesArray = [];
    this.templatesArray.push(template);
    this._tileIndexDirty = true;

    this.windowMain.handleDisplayStatus(`Template created at ${coords.join(", ")}!`);
    await this.#storeTemplates();
  }

  async #storeTemplates() {
    await GM.setValue("bmTemplates", JSON.stringify(this.templatesJSON));
  }

  /** Persists the current color visibility state (hidden color IDs) to GM storage. */
  async saveFilterColors() {
    const hiddenIDs = Array.from(this.shouldFilterColor.keys());
    await GM.setValue('bmFilterColors', JSON.stringify(hiddenIDs));
  }

  async downloadAllTemplates() {
    for (const template of this.templatesArray) {
      await this.downloadTemplate(template);
      await sleep(500);
    }
  }

  async downloadAllTemplatesFromStorage() {
    const templates = JSON.parse(GM_getValue("bmTemplates", "{}"))?.templates;
    if (!templates || Object.keys(templates).length === 0) return;

    for (const [key, template] of Object.entries(templates)) {
      if (!templates.hasOwnProperty(key)) continue;

      await this.downloadTemplate(
        new Template({
          displayName: template.name,
          sortID: key.split(" ")?.[0],
          authorID: key.split(" ")?.[1],
          chunked: template.tiles
        })
      );

      await sleep(500);
    }
  }

  async downloadTemplate(template) {
    template.calculateCoordsFromChunked();
    const templateFileName = `${template.coords.join("-")}_${template.displayName.replaceAll(" ", "-")}`;
    const blob = await this.convertTemplateToBlob(template);

    await GM.download({
      url: URL.createObjectURL(blob),
      name: templateFileName + ".png",
      conflictAction: "uniquify",
      onload: () => consoleLog(`Download of template '${templateFileName}' complete!`),
      onerror: (error, details) =>
        consoleError(`Download of template '${templateFileName}' failed because ${error}! Details: ${details}`),
      ontimeout: () => consoleWarn(`Download of template '${templateFileName}' has timed out!`)
    });
  }

  async convertTemplateToBlob(template) {
    const templateTiles64 = template.chunked;
    const templateTileKeysSorted = Object.keys(templateTiles64).sort();
    const templateTilesImageSorted = await Promise.all(
      templateTileKeysSorted.map(tileKey => convertBase64ToImage(templateTiles64[tileKey]))
    );

    let absoluteSmallestX = Infinity;
    let absoluteSmallestY = Infinity;
    let absoluteLargestX = 0;
    let absoluteLargestY = 0;

    templateTileKeysSorted.forEach((key, index) => {
      const [tileX, tileY, pixelX, pixelY] = key.split(",").map(Number);
      const tileImage = templateTilesImageSorted[index];

      const absoluteX = tileX * this.tileSize + pixelX;
      const absoluteY = tileY * this.tileSize + pixelY;

      absoluteSmallestX = Math.min(absoluteSmallestX, absoluteX);
      absoluteSmallestY = Math.min(absoluteSmallestY, absoluteY);
      absoluteLargestX = Math.max(absoluteLargestX, absoluteX + tileImage.width / this.drawMult);
      absoluteLargestY = Math.max(absoluteLargestY, absoluteY + tileImage.height / this.drawMult);
    });

    const templateWidth = absoluteLargestX - absoluteSmallestX;
    const templateHeight = absoluteLargestY - absoluteSmallestY;
    const canvasWidth = templateWidth * this.drawMult;
    const canvasHeight = templateHeight * this.drawMult;

    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;

    templateTileKeysSorted.forEach((key, index) => {
      const [tileX, tileY, pixelX, pixelY] = key.split(",").map(Number);
      const tileImage = templateTilesImageSorted[index];

      const absoluteX = tileX * this.tileSize + pixelX;
      const absoluteY = tileY * this.tileSize + pixelY;

      context.drawImage(
        tileImage,
        (absoluteX - absoluteSmallestX) * this.drawMult,
        (absoluteY - absoluteSmallestY) * this.drawMult,
        tileImage.width,
        tileImage.height
      );
    });

    context.globalCompositeOperation = "destination-over";
    context.drawImage(canvas, 0, -1);
    context.drawImage(canvas, 0, 1);
    context.drawImage(canvas, -1, 0);
    context.drawImage(canvas, 1, 0);

    const smallCanvas = new OffscreenCanvas(templateWidth, templateHeight);
    const smallContext = smallCanvas.getContext("2d");
    smallContext.imageSmoothingEnabled = false;

    smallContext.drawImage(
      canvas,
      0, 0, templateWidth * this.drawMult, templateHeight * this.drawMult,
      0, 0, templateWidth, templateHeight
    );

    return smallCanvas.convertToBlob({ type: "image/png" });

    function convertBase64ToImage(base64) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = "data:image/png;base64," + base64;
      });
    }
  }

  async drawTemplateOnTile(tileBlob, tileCoords) {
    if (!this.templatesShouldBeDrawn) return tileBlob;

    this._ensureTileCanvas();
    this._ensureAnalysisCanvas();
    if (this._tileIndexDirty) this._rebuildTileIndex();

    const drawSize = this.tileSize * this.drawMult;

    const tileCoordsKey =
      tileCoords[0].toString().padStart(4, "0") + "," +
      tileCoords[1].toString().padStart(4, "0");

    const refs = this._tileIndex.get(tileCoordsKey);
    if (!refs || refs.length === 0) {
      this.windowMain.handleDisplayStatus(`Sleeping\nVersion: ${this.version}`);
      return tileBlob;
    }

    const uniqueTemplates = new Set(refs.map(r => r.template));
    const templateCount = uniqueTemplates.size;
    if (templateCount > 0) {
      let totalPixels = 0;
      for (const t of uniqueTemplates) totalPixels += t.pixelCount?.total || 0;
      this.windowMain.handleDisplayStatus(
        `Displaying ${templateCount} template${templateCount === 1 ? "" : "s"}.\nTotal pixels: ${localizeNumber(totalPixels)}`
      );
    }

    const tileBitmap = await createImageBitmap(tileBlob);

    const analysisCtx = this._analysisContext;
    analysisCtx.setTransform(1, 0, 0, 1, 0, 0);
    analysisCtx.clearRect(0, 0, drawSize, drawSize);
    analysisCtx.drawImage(tileBitmap, 0, 0, drawSize, drawSize);

    const outCtx = this._tileContext;
    outCtx.setTransform(1, 0, 0, 1, 0, 0);
    outCtx.clearRect(0, 0, drawSize, drawSize);

    if (this.xModeEnabled) {
      const bg = this._getXBackground();
      outCtx.fillStyle = bg.css;
      outCtx.fillRect(0, 0, drawSize, drawSize);
    } else {
      outCtx.drawImage(tileBitmap, 0, 0, drawSize, drawSize);
    }

    const highlightPattern = this.settingsManager?.userSettings?.highlight || [[2, 0, 0]];
    const h0 = highlightPattern?.[0];
    const highlightDisabled =
      highlightPattern.length === 1 && h0?.[0] === 2 && h0?.[1] === 0 && h0?.[2] === 0;

    const shouldFilter = this.shouldFilterColor.size !== 0;

    for (const ref of refs) {
      const templateInst = ref.template;
      const tileKeyFull = ref.tileKey;

      const bitmap = templateInst.chunked?.[tileKeyFull];
      if (!bitmap) continue;

      const chunk32Original = templateInst.chunked32?.[tileKeyFull];

      const parts = tileKeyFull.split(",");
      const px = Number(parts[2]);
      const py = Number(parts[3]);

      const xDraw = px * this.drawMult;
      const yDraw = py * this.drawMult;

      const w = bitmap.width;
      const h = bitmap.height;

      const tileRegion = analysisCtx.getImageData(xDraw, yDraw, w, h);
      const tileRegion32 = new Uint32Array(tileRegion.data.buffer);

      const templateHasErased = !!templateInst.pixelCount?.colors?.get(-1);
      const needsMutation = this.xModeEnabled || shouldFilter || templateHasErased || !highlightDisabled;

      let correctPixels;

      if (!needsMutation && chunk32Original) {
        correctPixels = this.#calculateCorrectPixelsFast(tileRegion32, chunk32Original, w, h);
        outCtx.drawImage(bitmap, xDraw, yDraw);
      } else {
        let template32 = chunk32Original ? chunk32Original.slice() : null;

        if (!template32) {
          const tmpCanvas = new OffscreenCanvas(w, h);
          const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
          tmpCtx.imageSmoothingEnabled = false;
          tmpCtx.drawImage(bitmap, 0, 0);
          const img = tmpCtx.getImageData(0, 0, w, h);
          template32 = new Uint32Array(img.data.buffer);
        }

        const bg32 = this._getXBackground().u32;

        const res = this.#calculateCorrectPixelsOnTile_And_FilterTile({
          tile: tileRegion32,
          template: template32,
          templateInfo: [xDraw, yDraw, w, h],
          highlightPattern,
          highlightDisabled,
          xModeEnabled: this.xModeEnabled,
          xBg32: bg32
        });

        correctPixels = res.correctPixels;

        const imgData = new ImageData(new Uint8ClampedArray(res.filteredTemplate.buffer), w, h);
        const bmp = await createImageBitmap(imgData);
        outCtx.drawImage(bmp, xDraw, yDraw);
      }

      if (typeof templateInst.pixelCount.correct === "undefined") templateInst.pixelCount.correct = {};
      templateInst.pixelCount.correct[tileCoordsKey] = correctPixels;
    }

    return await this._tileCanvas.convertToBlob({ type: "image/png" });
  }

  #calculateCorrectPixelsFast(tile32, template32, width, height) {
    const pixelSize = this.drawMult;
    const tolerance = this.paletteTolerance;
    const lookupTable = this.paletteBM.LUT;

    const result = new Map();

    for (let templateRow = 1; templateRow < height; templateRow += pixelSize) {
      const tileRow = templateRow - 1;
      const tRowOff = templateRow * width;
      const bRowOff = tileRow * width;

      for (let templateCol = 1; templateCol < width; templateCol += pixelSize) {
        const templatePixel = template32[tRowOff + templateCol];
        const tilePixelAbove = tile32[bRowOff + templateCol];

        const ta = (templatePixel >>> 24) & 0xff;
        const ba = (tilePixelAbove >>> 24) & 0xff;

        if (ta <= tolerance || ba <= tolerance) continue;

        const tid = lookupTable.get(templatePixel) ?? -2;
        const bid = lookupTable.get(tilePixelAbove) ?? -2;

        if (tid !== bid) continue;

        result.set(tid, (result.get(tid) || 0) + 1);
      }
    }

    return result;
  }

  importJSON(json) {
    if (json?.whoami == this.name.replaceAll(" ", "")) this.#parseBlueMarble(json);
  }

  async #parseBlueMarble(json) {
    const templates = json.templates;
    const schemaVersion = json?.schemaVersion;
    const schemaVersionArray = schemaVersion.split(/[-\.\+]/);
    const schemaVersionBleedingEdge = this.schemaVersion.split(/[-\.\+]/);
    const scriptVersion = json?.scriptVersion;

    if (schemaVersionArray[0] == schemaVersionBleedingEdge[0]) {
      if (schemaVersionArray[1] != schemaVersionBleedingEdge[1]) {
        const windowWizard = new WindowWizard(this.name, this.version, this.schemaVersion, this);
        windowWizard.buildWindow();
      }

      const loadSchema = async ({ tileSize, drawMult, templatesArray }) => {
        if (!templates || Object.keys(templates).length === 0) return templatesArray;

        const actualTileSize = tileSize * drawMult;

        for (const templateKey in templates) {
          if (!templates.hasOwnProperty(templateKey)) continue;

          const templateValue = templates[templateKey];
          const templateKeyArray = templateKey.split(" ");
          const sortID = Number(templateKeyArray?.[0]);
          const authorID = templateKeyArray?.[1] || "0";
          const displayName = templateValue.name || `Template ${sortID || ""}`;

          const pixelCount = {
            total: templateValue.pixels?.total,
            colors: new Map(Object.entries(templateValue.pixels?.colors || {}).map(([k, v]) => [Number(k), v]))
          };

          const tilesbase64 = templateValue.tiles;
          const templateTiles = {};
          const templateTiles32 = {};

          for (const tileKey in tilesbase64) {
            if (!tilesbase64.hasOwnProperty(tileKey)) continue;

            const encodedTemplateBase64 = tilesbase64[tileKey];
            const templateUint8Array = base64ToUint8(encodedTemplateBase64);
            const templateBlob = new Blob([templateUint8Array], { type: "image/png" });
            const templateBitmap = await createImageBitmap(templateBlob);
            templateTiles[tileKey] = templateBitmap;

            const canvas = new OffscreenCanvas(actualTileSize, actualTileSize);
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.imageSmoothingEnabled = false;
            context.drawImage(templateBitmap, 0, 0);

            const imageData = context.getImageData(0, 0, templateBitmap.width, templateBitmap.height);
            templateTiles32[tileKey] = new Uint32Array(imageData.data.buffer);
          }

          const t = new Template({
            displayName,
            sortID: Number.isFinite(sortID) ? sortID : templatesArray.length,
            authorID
          });

          t.pixelCount = pixelCount;
          t.chunked = templateTiles;
          t.chunked32 = templateTiles32;

          templatesArray.push(t);
        }

        return templatesArray;
      };

      this.templatesArray = await loadSchema({ tileSize: this.tileSize, drawMult: this.drawMult, templatesArray: [] });
      this._tileIndexDirty = true;
    } else if (schemaVersionArray[0] < schemaVersionBleedingEdge[0]) {
      const windowWizard = new WindowWizard(this.name, this.version, this.schemaVersion, this);
      windowWizard.buildWindow();
    } else {
      this.windowMain.handleDisplayError(
        `Template version ${schemaVersion} is unsupported.\nUse Blue Marble version ${scriptVersion} or load a new template.`
      );
    }
  }

  setTemplatesShouldBeDrawn(value) {
    this.templatesShouldBeDrawn = value;
  }

  #calculateCorrectPixelsOnTile_And_FilterTile({
    tile: tile32,
    template: template32,
    templateInfo: templateInformation,
    highlightPattern,
    highlightDisabled,
    xModeEnabled,
    xBg32
  }) {
    const pixelSize = this.drawMult;
    const tilePixelOffsetY = -1;
    const tilePixelOffsetX = 0;

    const templateCoordXAbs = templateInformation[0];
    const templateCoordYAbs = templateInformation[1];
    const templateWidth = templateInformation[2];
    const templateHeight = templateInformation[3];

    const tileWidth = templateWidth;
    const tolerance = this.paletteTolerance;

    const shouldTransparentTilePixelsBeHighlighted = !this.settingsManager?.userSettings?.flags?.includes("hl-noTrans");
    const lookupTable = this.paletteBM.LUT;

    const _colorpalette = new Map();

    for (let templateRow = 1; templateRow < templateHeight; templateRow += pixelSize) {
      for (let templateColumn = 1; templateColumn < templateWidth; templateColumn += pixelSize) {
        const tileRowLocal = templateRow + tilePixelOffsetY;
        const tileColLocal = templateColumn + tilePixelOffsetX;

        if (tileRowLocal < 0 || tileColLocal < 0 || tileRowLocal >= templateHeight || tileColLocal >= templateWidth) continue;

        const tilePixelAbove = tile32[tileRowLocal * tileWidth + tileColLocal];
        const templatePixelIndex = templateRow * templateWidth + templateColumn;
        const templatePixel = template32[templatePixelIndex];

        const templatePixelAlpha = (templatePixel >>> 24) & 0xff;
        const tilePixelAlpha = (tilePixelAbove >>> 24) & 0xff;

        const bestTemplateColorID = lookupTable.get(templatePixel) ?? -2;
        const bestTileColorID = lookupTable.get(tilePixelAbove) ?? -2;

        if (this.shouldFilterColor.get(bestTemplateColorID)) {
          template32[templatePixelIndex] = xModeEnabled ? 0x00000000 : tilePixelAbove;
        }

        if (bestTemplateColorID == -1) {
          const blackTrans = 0x20000000;

          if (this.shouldFilterColor.get(bestTemplateColorID)) {
            template32[templatePixelIndex] = xModeEnabled ? 0x00000000 : 0x00000000;
          } else {
            const tileRowAbs = (templateCoordYAbs + templateRow + tilePixelOffsetY) / pixelSize;
            const tileColAbs = (templateCoordXAbs + templateColumn + tilePixelOffsetX) / pixelSize;

            if ((tileRowAbs & 1) == (tileColAbs & 1)) {
              template32[templatePixelIndex] = blackTrans;
              template32[(templateRow - 1) * templateWidth + (templateColumn - 1)] = blackTrans;
              template32[(templateRow - 1) * templateWidth + (templateColumn + 1)] = blackTrans;
              template32[(templateRow + 1) * templateWidth + (templateColumn - 1)] = blackTrans;
              template32[(templateRow + 1) * templateWidth + (templateColumn + 1)] = blackTrans;
            } else {
              template32[templatePixelIndex] = 0x00000000;
              template32[(templateRow - 1) * templateWidth + templateColumn] = blackTrans;
              template32[(templateRow + 1) * templateWidth + templateColumn] = blackTrans;
              template32[templateRow * templateWidth + (templateColumn - 1)] = blackTrans;
              template32[templateRow * templateWidth + (templateColumn + 1)] = blackTrans;
            }
          }
        }

        const opaqueEnough = (templatePixelAlpha > tolerance) && (tilePixelAlpha > tolerance);
        const correctNormal = opaqueEnough && (bestTileColorID == bestTemplateColorID);
        const correctErased = (bestTemplateColorID == -1) && (tilePixelAbove <= tolerance);
        const isCorrect = correctNormal || correctErased;

        if (xModeEnabled && isCorrect && !this.shouldFilterColor.get(bestTemplateColorID)) {
          template32[templatePixelIndex] = 0x00000000;
        }

        if (!highlightDisabled && (templatePixelAlpha > tolerance) && (bestTileColorID != bestTemplateColorID)) {
          if (shouldTransparentTilePixelsBeHighlighted || (tilePixelAlpha > tolerance)) {
            const templatePixelColor = template32[templatePixelIndex];

            for (const subpixelPattern of highlightPattern) {
              const [subpixelState, subpixelColumnDelta, subpixelRowDelta] = subpixelPattern;

              const subpixelColor =
                (subpixelState != 0)
                  ? ((subpixelState != 1) ? templatePixelColor : 0xff0000ff)
                  : 0x00000000;

              template32[(templateRow + subpixelRowDelta) * templateWidth + (templateColumn + subpixelColumnDelta)] =
                subpixelColor;
            }
          }
        }

        if (correctErased) {
          _colorpalette.set(bestTemplateColorID, (_colorpalette.get(bestTemplateColorID) || 0) + 1);
          continue;
        }

        if (templatePixelAlpha <= tolerance || tilePixelAlpha <= tolerance) continue;
        if (bestTileColorID != bestTemplateColorID) continue;

        _colorpalette.set(bestTemplateColorID, (_colorpalette.get(bestTemplateColorID) || 0) + 1);
      }
    }

    return { correctPixels: _colorpalette, filteredTemplate: template32 };
  }
}