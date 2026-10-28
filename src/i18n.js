// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a free text of the PVS: only our own words, error codes, numbers we
// checked and the fingerprint of a certificate met. Never the password, the
// serial number of the PVS, its MAC nor the session cookie.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  // Rounded first: 59.99 s is told "1 min", never "60 s".
  if (Math.round(ms / 1000) >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** A status is bounded: Gladys shows it in one block. */
const MAX_STATUS = 1500;
const bound = (text) => (text.length > MAX_STATUS ? `${text.slice(0, MAX_STATUS - 1)}…` : text);

/** Our words for an error code of src/pvs/errors.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  redirect: {
    en: 'redirect refused (is it the PVS?)',
    fr: 'redirection refusée (est-ce bien la PVS ?)',
  },
  server: { en: 'error of the PVS', fr: 'erreur de la PVS' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  credentials: { en: 'password refused', fr: 'mot de passe refusé' },
  access: {
    en: 'variables refused right after the login',
    fr: 'variables refusées juste après la connexion',
  },
  no_serial: {
    en: 'the PVS does not give its serial number: type the password (the last 5 characters of the serial number on its label)',
    fr: 'la PVS ne donne pas son numéro de série : saisissez le mot de passe (les 5 derniers caractères du numéro de série de son étiquette)',
  },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  bad_answer: {
    en: 'not an answer of the varserver API (is it a PVS5/PVS6 with a firmware from 2025.06 on?)',
    fr: 'ce n’est pas une réponse de l’API varserver (est-ce une PVS5/PVS6 avec un firmware de 2025.06 ou plus récent ?)',
  },
  tls: { en: 'TLS handshake refused', fr: 'négociation TLS refusée' },
  pin_unavailable: {
    en: '/data cannot be written: the certificate cannot be pinned, nothing sent',
    fr: '/data ne peut pas être écrit : le certificat ne peut pas être épinglé, rien envoyé',
  },
  pin_unreadable: {
    en: '/data cannot be read: no certificate learned, nothing sent (or type its fingerprint)',
    fr: '/data ne peut pas être lu : aucun certificat appris, rien envoyé (ou saisissez son empreinte)',
  },
  late: { en: 'configuration changed', fr: 'configuration changée' },
};

export function reason(err) {
  const key =
    err?.code === 'pin_unavailable' && err.reason === 'unreadable' ? 'pin_unreadable' : err?.code;
  const text = REASON[key] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    (err?.code === 'http' || err?.code === 'server') && Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

const num = (value) => Math.round(value * 1000) / 1000;

/** `ago` ms ago, or undefined for a read made by this click. */
const when = (ago) =>
  ago === undefined
    ? { en: 'Read now', fr: 'Lu à l’instant' }
    : { en: `Last read ${delay(ago).en} ago`, fr: `Dernière lecture il y a ${delay(ago).fr}` };

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: bound(join('en', first, notes)),
  fr: bound(join('fr', first, notes)),
});

/** The next read, or nothing when no read is planned (a refused password). */
const nextRead = (next) =>
  next === undefined
    ? { en: '', fr: '' }
    : { en: ` Next read in ${delay(next).en}.`, fr: ` Prochaine lecture dans ${delay(next).fr}.` };

/** The name of a counter (src/devices.js `label`). */
const COUNTER = {
  production: { en: 'production index of the site', fr: 'index de production du site' },
  home: { en: 'home consumption of the site', fr: 'consommation de la maison' },
  inverter: { en: 'lifetime production', fr: 'production totale' },
  meterProduction: { en: 'production meter total', fr: 'total du compteur de production' },
  bought: { en: 'total bought from the grid', fr: 'total acheté au réseau' },
  sold: { en: 'total sold to the grid', fr: 'total vendu au réseau' },
};

/** A held counter in words: which, of which device, from and to. */
const heldText = (lang, h) => {
  const name = COUNTER[h.label]?.[lang] ?? h.key;
  const of = h.name ? ` (${h.name})` : '';
  if (lang === 'en') {
    return h.direction === 'down'
      ? `${name}${of} dropped from ${num(h.from)} to ${num(h.to)} kWh`
      : `${name}${of} jumped from ${num(h.from)} to ${num(h.to)} kWh`;
  }
  return h.direction === 'down'
    ? `${name}${of} a baissé de ${num(h.from)} à ${num(h.to)} kWh`
    : `${name}${of} a sauté de ${num(h.from)} à ${num(h.to)} kWh`;
};
const helds = (lang, list) => {
  const shown = list.slice(0, 5).map((h) => heldText(lang, h));
  if (list.length > 5)
    shown.push(lang === 'en' ? `${list.length - 5} more` : `${list.length - 5} autres`);
  return shown.join('; ');
};

const KIND = {
  inverter: { en: 'micro-inverters', fr: 'micro-onduleurs' },
  meter: { en: 'meters', fr: 'compteurs' },
  ess: { en: 'batteries', fr: 'batteries' },
  transfer_switch: { en: 'transfer switches', fr: 'commutateurs de transfert' },
};
const kinds = (lang, list) => list.map((k) => KIND[k][lang]).join(', ');

export const T = {
  incomplete: {
    en: 'Enter the address of your SunPower PVS (its IP address on your network, e.g. 192.168.1.20).',
    fr: 'Saisissez l’adresse de votre PVS SunPower (son adresse IP sur votre réseau, ex. 192.168.1.20).',
  },
  badAddress: {
    en: 'The PVS address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.20).',
    fr: 'L’adresse de la PVS n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.20).',
  },
  badAddressHttp: {
    en: 'The PVS answers in HTTPS only: enter its address without "http://".',
    fr: 'La PVS ne répond qu’en HTTPS : saisissez son adresse sans « http:// ».',
  },
  badPassword: {
    en: 'The password holds a line break or a control character, or is too long: type it again.',
    fr: 'Le mot de passe contient un retour à la ligne ou un caractère de contrôle, ou il est trop long : saisissez-le à nouveau.',
  },
  badFingerprint: {
    en: 'The certificate fingerprint is not valid: 64 hexadecimal digits (with or without colons), as the status showed it.',
    fr: 'L’empreinte du certificat n’est pas valide : 64 chiffres hexadécimaux (avec ou sans deux-points), tels que le statut l’a affichée.',
  },
  configUnread: (wait) => ({
    en: `The configuration could not be read from Gladys: tried again in ${delay(wait).en}.`,
    fr: `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${delay(wait).fr}.`,
  }),
  badgeHeld: {
    en: 'A lifetime counter is held back (see the integration status).',
    fr: 'Un compteur cumulé est retenu (voir le statut de l’intégration).',
  },
  refused: (address, typed, notes) =>
    withNotes(
      typed
        ? {
            en: `The PVS at ${address} refuses the password: nothing is read until another password is saved or the "Test the connection" button succeeds.`,
            fr: `La PVS à ${address} refuse le mot de passe : plus rien n’est lu tant qu’un autre mot de passe n’est pas enregistré ou que le bouton « Tester la connexion » ne réussit pas.`,
          }
        : {
            en: `The PVS at ${address} refuses the password made from its serial number: type the password (the last 5 characters of the serial number on its label). Nothing is read until then, or until the "Test the connection" button succeeds.`,
            fr: `La PVS à ${address} refuse le mot de passe tiré de son numéro de série : saisissez le mot de passe (les 5 derniers caractères du numéro de série de son étiquette). Plus rien n’est lu d’ici là, ou tant que le bouton « Tester la connexion » ne réussit pas.`,
          },
      notes,
    ),
  paused: (address, pause, left, notes) =>
    withNotes(
      {
        en: `The PVS at ${address} answered ${pause.code === 'rate_limited' ? '"too many requests"' : `an error${pause.status ? ` ${pause.status}` : ''}`}: reads paused for ${delay(left).en}.`,
        fr: `La PVS à ${address} a répondu ${pause.code === 'rate_limited' ? '« trop de requêtes »' : `une erreur${pause.status ? ` ${pause.status}` : ''}`} : lectures en pause pendant ${delay(left).fr}.`,
      },
      notes,
    ),
  certificateChanged: (address, seen, typed, notes) =>
    withNotes(
      typed
        ? {
            en: `The certificate of the PVS at ${address} is not the fingerprint typed: nothing sent. Certificate met: ${seen}.`,
            fr: `Le certificat de la PVS à ${address} n’est pas l’empreinte saisie : rien envoyé. Certificat rencontré : ${seen}.`,
          }
        : {
            en: `The certificate of the PVS at ${address} is not the one met at the first connection: nothing sent (the password never goes to an unknown certificate). If you changed or reset the PVS, copy this fingerprint into the "Certificate fingerprint" field and save: ${seen}.`,
            fr: `Le certificat de la PVS à ${address} n’est pas celui de la première connexion : rien envoyé (le mot de passe ne part jamais vers un certificat inconnu). Si vous avez changé ou réinitialisé la PVS, copiez cette empreinte dans le champ « Empreinte du certificat » et enregistrez : ${seen}.`,
          },
      notes,
    ),
  unreachable: (address, err, wait, notes) =>
    withNotes(
      {
        en: `The PVS at ${address} could not be read (${reason(err).en}): next try in ${delay(wait).en}.`,
        fr: `La PVS à ${address} n’a pas pu être lue (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  otherPvs: (address, notes) =>
    withNotes(
      {
        en: `Another PVS answers at ${address} (another network MAC address): nothing is published, so that its counters are never mixed with the first one's. If you replaced the PVS, click "Accept the held values" twice.`,
        fr: `Une autre PVS répond à ${address} (autre adresse MAC réseau) : rien n’est publié, pour ne jamais mêler ses compteurs à ceux de la première. Si vous avez remplacé la PVS, cliquez deux fois sur « Accepter les valeurs retenues ».`,
      },
      notes,
    ),
  noIdentity: (address, notes) =>
    withNotes(
      {
        en: `The PVS at ${address} answers, but its network MAC address could not be checked: nothing is published from this read.`,
        fr: `La PVS à ${address} répond, mais son adresse MAC réseau n’a pas pu être vérifiée : rien n’est publié de cette lecture.`,
      },
      notes,
    ),
  ok: (address, counts, notes) => {
    const parts = (lang) =>
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${KIND[k][lang]}`)
        .join(', ');
    const en = parts('en');
    const fr = parts('fr');
    return withNotes(
      {
        en: `Connected to the PVS at ${address}${en ? `: ${en}` : ''}.`,
        fr: `Connecté à la PVS à ${address}${fr ? ` : ${fr}` : ''}.`,
      },
      notes,
    );
  },
  waiting: (address, notes) =>
    withNotes(
      {
        en: `Waiting for the first read of the PVS at ${address}.`,
        fr: `En attente de la première lecture de la PVS à ${address}.`,
      },
      notes,
    ),
  notes: {
    storeUnreadable: (code) => ({
      en: `/data cannot be read (${code}): no counter published, no certificate learned, until it reads again.`,
      fr: `/data ne peut pas être lu (${code}) : aucun compteur publié, aucun certificat appris, jusqu’à ce qu’il se lise à nouveau.`,
    }),
    saveFailed: {
      en: '/data cannot be written: the lifetime counters are held back.',
      fr: '/data ne peut pas être écrit : les compteurs cumulés sont retenus.',
    },
    held: (list) => ({
      en: `Held back, never counted without you: ${helds('en', list)}. If it is right (a device replaced, a counter set back), click "Accept the held values" twice.`,
      fr: `Retenu, jamais compté sans vous : ${helds('fr', list)}. Si c’est juste (appareil remplacé, compteur remis à zéro), cliquez deux fois sur « Accepter les valeurs retenues ».`,
    }),
    kindsFailed: (list) => ({
      en: `The ${kinds('en', list)} could not be read this time (tried again later).`,
      fr: `Les ${kinds('fr', list)} n’ont pas pu être lus cette fois (nouvel essai plus tard).`,
    }),
    unnamed: (n) => ({
      en: `${n} device(s) without a usable serial number: not offered.`,
      fr: `${n} appareil(s) sans numéro de série utilisable : non proposé(s).`,
    }),
    secretId: (n) => ({
      en: `${n} device(s) whose serial number holds the password: not offered.`,
      fr: `${n} appareil(s) dont le numéro de série contient le mot de passe : non proposé(s).`,
    }),
    tooMany: (list) => ({
      en: `More ${kinds('en', list)} than this integration reads: the first ones only.`,
      fr: `Plus de ${kinds('fr', list)} que cette intégration n’en lit : les premiers seulement.`,
    }),
    liveStale: {
      en: 'The live data of the PVS is more than 2 hours old: not published.',
      fr: 'Les données instantanées de la PVS ont plus de 2 heures : non publiées.',
    },
    noDevice: (n) => ({
      en: `${n} device(s) to create in the "Discover" tab.`,
      fr: `${n} appareil(s) à créer dans l’onglet « Découverte ».`,
    }),
  },
  accept: {
    nothing: {
      en: 'Nothing is held back: nothing to accept.',
      fr: 'Rien n’est retenu : rien à accepter.',
    },
    confirm: (list, other, within) => {
      const items = (lang) => {
        const parts = [];
        if (other)
          parts.push(
            lang === 'en' ? 'the new PVS at this address' : 'la nouvelle PVS à cette adresse',
          );
        if (list.length > 0) parts.push(helds(lang, list));
        return parts.join('; ');
      };
      return {
        en: bound(
          `Held back: ${items('en')}. Click again within ${delay(within).en} (after 3 s) to accept exactly this. A jump accepted is counted at once; a drop accepted counts nothing and the counter goes on from there.`,
        ),
        fr: bound(
          `Retenu : ${items('fr')}. Cliquez à nouveau dans les ${delay(within).fr} (après 3 s) pour accepter exactement cela. Un saut accepté est compté d’un coup ; une baisse acceptée ne compte rien et le compteur repart de là.`,
        ),
      };
    },
    done: (accepted, changed, pvs, pvsChanged) => {
      const text = (lang) => {
        const parts = [];
        if (pvs) parts.push(lang === 'en' ? 'New PVS accepted.' : 'Nouvelle PVS acceptée.');
        if (pvsChanged) {
          parts.push(
            lang === 'en'
              ? 'The PVS met is not the one listed: not accepted.'
              : 'La PVS rencontrée n’est pas celle listée : non acceptée.',
          );
        }
        if (accepted.length > 0) {
          parts.push(
            lang === 'en'
              ? `Accepted, published at the next read: ${helds('en', accepted)}.`
              : `Accepté, publié à la prochaine lecture : ${helds('fr', accepted)}.`,
          );
        }
        if (changed.length > 0) {
          parts.push(
            lang === 'en'
              ? `Changed since the first click, not accepted: ${helds('en', changed)}.`
              : `Changé depuis le premier clic, non accepté : ${helds('fr', changed)}.`,
          );
        }
        return bound(parts.join(' '));
      };
      return { en: text('en'), fr: text('fr') };
    },
  },
  test: {
    slow: {
      en: 'The PVS is slow to answer: the result will be in the integration status.',
      fr: 'La PVS tarde à répondre : le résultat sera dans le statut de l’intégration.',
    },
    notYet: (next, interval) => ({
      en: `No read yet: the first one comes in ${delay(next ?? interval).en}.`,
      fr: `Pas encore de lecture : la première arrive dans ${delay(next ?? interval).fr}.`,
    }),
    reading: ({ power, index, held, inverters }, ago, next) => {
      const w = when(ago);
      const p = (lang) =>
        power === undefined
          ? lang === 'en'
            ? 'production power unknown'
            : 'puissance de production inconnue'
          : lang === 'en'
            ? `production ${Math.round(power)} W`
            : `production ${Math.round(power)} W`;
      const i = (lang) =>
        index === undefined
          ? ''
          : lang === 'en'
            ? `, production index ${num(index)} kWh${held ? ' (held back, not sent)' : ''}`
            : `, index de production ${num(index)} kWh${held ? ' (retenu, non envoyé)' : ''}`;
      const n = (lang) => (inverters === undefined ? '' : `, ${inverters} ${KIND.inverter[lang]}`);
      return {
        en: `${w.en}: ${p('en')}${i('en')}${n('en')}.${nextRead(next).en}`,
        fr: `${w.fr} : ${p('fr')}${i('fr')}${n('fr')}.${nextRead(next).fr}`,
      };
    },
    failed: (address, err, ago, next) => {
      const w = when(ago);
      return {
        en: `${w.en}: the PVS at ${address} could not be read (${reason(err).en}).${nextRead(next).en}`,
        fr: `${w.fr} : la PVS à ${address} n’a pas pu être lue (${reason(err).fr}).${nextRead(next).fr}`,
      };
    },
  },
};
