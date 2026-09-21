// ============================================================
//  config.js  —  NYC 311 snow vs. pothole complaints by NTA
// ============================================================
//  This deployment has a fixed variable pairing: the X/Y pickers
//  have been removed from index.html, so VARIABLES holds exactly
//  the two fields below and DEFAULT_VAR_X / DEFAULT_VAR_Y decide
//  which is which. Everything else works as in the generic tool.
// ============================================================

export const DATA_FILE = './data/NTA_311_Rates.geojson';

// ============================================================
//  PAGE IDENTITY
// ============================================================

export const PAGE_TITLE = 'Winter 2025-26 311 Snow Complaint Rate and 2026 311 Pothole Complaint Rate by Neighborhood Tabulation Area';

export const DATA_CREDIT_HTML = `
  Complaints: NYC
  <a href="https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9" rel="noopener" target="_blank">311 Service Requests</a>,
  aggregated to 2020 Neighborhood Tabulation Areas
  (<a href="https://www.nyc.gov/content/planning/pages/resources/datasets/neighborhood-tabulation" rel="noopener" target="_blank">NYC DCP</a>)
  and expressed per 1,000 residents. Non-residential NTAs — parks, cemeteries,
  airports and rail yards — are drawn in grey and excluded from the scatterplot
  and statistics: their populations are too small for a rate to mean anything.
  Built on
  <a href="https://github.com/ssitari/ChoroplethEDABivariate" rel="noopener" target="_blank">ChoroplethEDABivariate</a>.
`;

export const GEOGRAPHY_LABEL        = 'neighborhood';
export const GEOGRAPHY_LABEL_PLURAL = 'neighborhoods';

export const PROJECTION = () => d3.geoMercator();

export const FEATURE_ID_FIELD    = 'NTA2020';
export const FEATURE_NAME_FIELD  = 'NTAName';
export const FEATURE_GROUP_FIELD = 'BoroName';   // tooltip's second line

// ============================================================
//  VARIABLES
//  Fixed pairing — snow on X, potholes on Y.
// ============================================================

export const VARIABLES = [
  {
    id:    'snow',
    label: 'Snow complaints per 1,000 residents',
    prop:  'SnowRate',
    fmt:   v => v.toFixed(1),
    unit:  'per 1k',
  },
  {
    id:    'pothole',
    label: 'Pothole complaints per 1,000 residents',
    prop:  'PotholeRate',
    fmt:   v => v.toFixed(1),
    unit:  'per 1k',
  },
];

// ============================================================
//  DEFAULTS
// ============================================================

export const DEFAULT_VAR_X = 'snow';
export const DEFAULT_VAR_Y = 'pothole';

// 'DkBlue_DkRed', 'DkViolet_DkGreen', 'DkCyan_DkBrown',
// 'GrPink', 'PurpleOrange', 'BlueTan'
export const DEFAULT_BIVARIATE_SCHEME = 'DkBlue_DkRed';

export const NULL_COLOR = '#d0d0d0';
export const SELECTION_COLOR = '#e07b39';
export const DEEMPHASIS_OPACITY = 0.2;
export const DOT_RADIUS = 5;
