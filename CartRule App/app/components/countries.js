// ISO 3166-1 alpha-2 codes for the country pickers; names come from the
// Intl.DisplayNames (English on both server and client, so hydration matches).
export const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AR AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MK ML MM MN MO MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PS PT PY QA RE RO RS RU " +
  "RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW " +
  "TZ UA UG UM US UY UZ VA VC VE VG VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

let displayNames = null;

export function countryName(code) {
  const c = String(code ?? "").toUpperCase();
  try {
    displayNames = displayNames ?? new Intl.DisplayNames(["en"], { type: "region" });
    const name = displayNames.of(c);
    return name && name !== c ? `${name} (${c})` : c;
  } catch (_e) {
    return c;
  }
}
