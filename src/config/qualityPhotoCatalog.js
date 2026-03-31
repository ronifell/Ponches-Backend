/**
 * Quality photo rules: work types, slot IDs (sent as photoType), camera vs gallery.
 * Keep in sync with android/.../QualityPhotoCatalog.kt
 */

const MAX_STB_COUNT = 5;

const SOURCE_CAMERA = 'CAMERA';
const SOURCE_GALLERY = 'GALLERY';

const WORK_META = {
  DTH_REPAIR: { label: 'DTH repair', usesStb: true },
  COPPER_FIBER_REPAIR: { label: 'Copper/fiber internet repair', usesStb: false },
  DTH_INSTALL: { label: 'DTH installation / relocation / additional element', usesStb: true },
  VOICE_INTERNET_INSTALL: { label: 'Voice/internet installation / relocation', usesStb: false },
  MIXED_VID_DTH_INSTALL: { label: 'Mixed voice–internet–DTH installation', usesStb: true },
  MIXED_IPTV_CLARO_INSTALL: {
    label: 'Mixed voice–internet–IPTV Claro TV Plus / additional element',
    usesStb: true
  },
  A: { label: 'Legacy type A', usesStb: false }
};

function slot(id, label, source) {
  return { id, label, source };
}

function dthCoreSlots() {
  return [
    slot('DTH_LNB', 'LNB', SOURCE_CAMERA),
    slot('DTH_DISH_REAR', 'Position behind the dish', SOURCE_CAMERA),
    slot('DTH_DISH_BASE', 'Dish base', SOURCE_CAMERA),
    slot('DTH_COAX_EXT', 'External coaxial cable', SOURCE_CAMERA),
    slot('DTH_COAX_INT', 'Internal coaxial cable', SOURCE_CAMERA),
    slot('DTH_TP1', 'TP 1', SOURCE_CAMERA),
    slot('DTH_TP2', 'TP 2', SOURCE_CAMERA)
  ];
}

function dthStbSlots(stbCount) {
  const n = Math.min(MAX_STB_COUNT, Math.max(1, stbCount | 0));
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(slot(`DTH_STB_${i}`, `STB ${i}`, SOURCE_CAMERA));
    out.push(slot(`DTH_BNC_${i}`, `BNC connector ${i}`, SOURCE_CAMERA));
  }
  return out;
}

function copperFiberSlots() {
  return [
    slot('COP_TERM', 'Terminal', SOURCE_CAMERA),
    slot('COP_DROP_IN', 'Drop input', SOURCE_CAMERA),
    slot('COP_DROP_EXT', 'External drop cable', SOURCE_CAMERA),
    slot('COP_TESTER_INT', 'Tester and/or internal input', SOURCE_CAMERA),
    slot('COP_CABLE_INT', 'Internal cable', SOURCE_CAMERA),
    slot('COP_JACK', 'Jack/rosette', SOURCE_CAMERA),
    slot('COP_MODEM', 'Modem/ONT', SOURCE_CAMERA),
    slot('COP_SACS_PARAMS', 'Parameters (SACS)', SOURCE_CAMERA)
  ];
}

function voiceInternetSlots() {
  return [
    slot('VI_TERM', 'Terminal', SOURCE_CAMERA),
    slot('VI_DROP_IN_1', 'Drop input (1)', SOURCE_CAMERA),
    slot('VI_DROP_IN_2', 'Drop input (2)', SOURCE_CAMERA),
    slot('VI_TESTER_INDOOR', 'Tester and/or indoor input', SOURCE_CAMERA),
    slot('VI_INDOOR_IN', 'Indoor input', SOURCE_CAMERA),
    slot('VI_JACK', 'Jack/rosette', SOURCE_CAMERA),
    slot('VI_MODEM', 'Modem/ONT', SOURCE_CAMERA),
    slot('VI_SACS_PARAMS', 'Parameters (SACS)', SOURCE_CAMERA)
  ];
}

function iptvExtraSlots(stbCount) {
  const n = Math.min(MAX_STB_COUNT, Math.max(1, stbCount | 0));
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(slot(`IPTV_UTP_${i}`, `UTP cable ${i}`, SOURCE_CAMERA));
    out.push(slot(`IPTV_STB_${i}`, `STB ${i}`, SOURCE_CAMERA));
    out.push(slot(`IPTV_RJ45_${i}`, `RJ45 connector + rubber cap ${i}`, SOURCE_CAMERA));
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
        slot('BEFORE', 'Before', SOURCE_CAMERA),
        slot('DURING', 'During', SOURCE_CAMERA),
        slot('AFTER', 'After', SOURCE_CAMERA)
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
