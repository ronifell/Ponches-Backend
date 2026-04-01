/**
 * Quality photo rules: work types, slot IDs (sent as photoType), camera vs gallery.
 * Keep in sync with android/.../QualityPhotoCatalog.kt
 */

const MAX_STB_COUNT = 5;

const SOURCE_CAMERA = 'CAMERA';
const SOURCE_GALLERY = 'GALLERY';

const WORK_META = {
  DTH_REPAIR: { label: 'Reparación DTH', usesStb: true },
  COPPER_FIBER_REPAIR: { label: 'Reparación internet cobre/fibra', usesStb: false },
  DTH_INSTALL: { label: 'Instalación DTH / reubicación / elemento adicional', usesStb: true },
  VOICE_INTERNET_INSTALL: { label: 'Instalación voz/internet / reubicación', usesStb: false },
  MIXED_VID_DTH_INSTALL: { label: 'Instalación mixta voz–internet–DTH', usesStb: true },
  MIXED_IPTV_CLARO_INSTALL: {
    label: 'Instalación mixta voz–internet–IPTV Claro TV Plus / elemento adicional',
    usesStb: true
  },
  A: { label: 'Tipo A (legado)', usesStb: false }
};

function slot(id, label, source) {
  return { id, label, source };
}

function dthCoreSlots() {
  return [
    slot('DTH_LNB', 'LNB', SOURCE_CAMERA),
    slot('DTH_DISH_REAR', 'Posición detrás de la parabólica', SOURCE_CAMERA),
    slot('DTH_DISH_BASE', 'Base de la parabólica', SOURCE_CAMERA),
    slot('DTH_COAX_EXT', 'Cable coaxial exterior', SOURCE_CAMERA),
    slot('DTH_COAX_INT', 'Cable coaxial interior', SOURCE_CAMERA),
    slot('DTH_TP1', 'TP 1', SOURCE_CAMERA),
    slot('DTH_TP2', 'TP 2', SOURCE_CAMERA)
  ];
}

function dthStbSlots(stbCount) {
  const n = Math.min(MAX_STB_COUNT, Math.max(1, stbCount | 0));
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(slot(`DTH_STB_${i}`, `Decodificador (STB) ${i}`, SOURCE_CAMERA));
    out.push(slot(`DTH_BNC_${i}`, `Conector BNC ${i}`, SOURCE_CAMERA));
  }
  return out;
}

function copperFiberSlots() {
  return [
    slot('COP_TERM', 'Terminal', SOURCE_CAMERA),
    slot('COP_DROP_IN', 'Entrada del drop', SOURCE_CAMERA),
    slot('COP_DROP_EXT', 'Cable drop exterior', SOURCE_CAMERA),
    slot('COP_TESTER_INT', 'Tester y/o entrada interior', SOURCE_CAMERA),
    slot('COP_CABLE_INT', 'Cable interior', SOURCE_CAMERA),
    slot('COP_JACK', 'Jack/roseta', SOURCE_CAMERA),
    slot('COP_MODEM', 'Módem/ONT', SOURCE_CAMERA),
    slot('COP_SACS_PARAMS', 'Parámetros (SACS)', SOURCE_GALLERY)
  ];
}

function voiceInternetSlots() {
  return [
    slot('VI_TERM', 'Terminal', SOURCE_CAMERA),
    slot('VI_DROP_IN_1', 'Entrada del drop (1)', SOURCE_CAMERA),
    slot('VI_DROP_IN_2', 'Entrada del drop (2)', SOURCE_CAMERA),
    slot('VI_TESTER_INDOOR', 'Tester y/o entrada en interior', SOURCE_CAMERA),
    slot('VI_INDOOR_IN', 'Entrada en interior', SOURCE_CAMERA),
    slot('VI_JACK', 'Jack/roseta', SOURCE_CAMERA),
    slot('VI_MODEM', 'Módem/ONT', SOURCE_CAMERA),
    slot('VI_SACS_PARAMS', 'Parámetros (SACS)', SOURCE_GALLERY)
  ];
}

function iptvExtraSlots(stbCount) {
  const n = Math.min(MAX_STB_COUNT, Math.max(1, stbCount | 0));
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(slot(`IPTV_UTP_${i}`, `Cable UTP ${i}`, SOURCE_CAMERA));
    out.push(slot(`IPTV_STB_${i}`, `Decodificador (STB) ${i}`, SOURCE_CAMERA));
    out.push(slot(`IPTV_RJ45_${i}`, `Conector RJ45 + capuchón ${i}`, SOURCE_CAMERA));
  }
  return out;
}

function slotsForWorkType(workType, stbCount) {
  const wt = String(workType || '').trim().toUpperCase();
  const sc = Math.min(MAX_STB_COUNT, Math.max(1, Number(stbCount) || 1));

  switch (wt) {
    case 'DTH_REPAIR':
    case 'DTH_INSTALL':
      return [...dthCoreSlots(), ...dthStbSlots(sc)];
    case 'COPPER_FIBER_REPAIR':
      return copperFiberSlots();
    case 'VOICE_INTERNET_INSTALL':
      return voiceInternetSlots();
    case 'MIXED_VID_DTH_INSTALL':
      return [...voiceInternetSlots(), ...dthCoreSlots(), ...dthStbSlots(sc)];
    case 'MIXED_IPTV_CLARO_INSTALL':
      return [...copperFiberSlots(), ...iptvExtraSlots(sc)];
    case 'A':
      return [
        slot('BEFORE', 'Antes', SOURCE_CAMERA),
        slot('DURING', 'Durante', SOURCE_CAMERA),
        slot('AFTER', 'Después', SOURCE_CAMERA)
      ];
    default:
      return [];
  }
}

function normalizeWorkType(workType) {
  return String(workType || '').trim().toUpperCase();
}

function clampStbCount(workType, raw) {
  const wt = normalizeWorkType(workType);
  if (!WORK_META[wt]?.usesStb) return 1;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(MAX_STB_COUNT, n);
}

function usesStbCount(workType) {
  return Boolean(WORK_META[normalizeWorkType(workType)]?.usesStb);
}

function allowedPhotoTypes(workType, stbCount) {
  return slotsForWorkType(workType, stbCount).map((s) => s.id);
}

function isGalleryAllowed(workType, stbCount, photoType) {
  const pt = String(photoType || '').trim().toUpperCase();
  const slots = slotsForWorkType(workType, stbCount);
  const found = slots.find((s) => s.id === pt);
  return found?.source === SOURCE_GALLERY;
}

function listWorkTypesForApi() {
  return Object.entries(WORK_META).map(([id, m]) => ({ id, label: m.label, usesStb: m.usesStb }));
}

module.exports = {
  MAX_STB_COUNT,
  SOURCE_CAMERA,
  SOURCE_GALLERY,
  WORK_META,
  slotsForWorkType,
  normalizeWorkType,
  clampStbCount,
  usesStbCount,
  allowedPhotoTypes,
  isGalleryAllowed,
  listWorkTypesForApi
};
