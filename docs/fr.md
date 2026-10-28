# PVS SunPower

Intégration **non officielle**, sans lien avec SunPower ni SunStrong
Management. Elle lit une passerelle de supervision **SunPower PVS5 ou PVS6**
par l'**API locale** publiée par SunStrong en 2025 (varserver, HTTPS sur
votre réseau domestique), sans cloud. **Lecture seule** : elle ne fait que
lire, rien n'est jamais écrit dans la PVS.

**Jamais testé avec une vraie PVS** : construit d'après le document
« LocalAPI » de SunStrong, les listes publiques de variables et le code de la
bibliothèque pypvs (MIT, SunStrong Management), et testé contre une fausse
PVS bâtie à partir d'eux.

## Prérequis

- Une PVS6 avec un firmware **2025.06 build 61840** ou plus récent
  (SunStrong : PVS6 2025.06 b61839 au moins, PVS5 2025.11 b5412 ; la PVS2
  n'est pas prise en charge) ;
- la PVS sur votre réseau domestique (son port LAN ou son Wi-Fi), joignable
  depuis Gladys. L'ancien port installateur et son API `dl_cgi` ne sont pas
  utilisés.

## Configuration

- **Adresse de la PVS** : son adresse IP sur votre réseau (visible dans votre
  box), avec un port seulement s'il n'est pas 443. Donnez-lui une adresse
  fixe dans votre box.
- **Mot de passe** (facultatif) : laissez-le vide. L'intégration lit le
  numéro de série de la PVS et prend ses 5 derniers caractères, le mot de
  passe documenté par SunStrong (utilisateur `ssm_owner`). Saisissez-le
  seulement si le statut le demande : les 5 derniers caractères du numéro de
  série imprimé sur l'étiquette de la PVS. Il est gardé par Gladys dans sa
  base, jamais réaffiché, envoyé seulement à la PVS, en HTTPS vers son
  certificat épinglé, et jamais écrit dans les journaux. Le numéro de série
  et le mot de passe ne sont écrits ni dans les journaux, ni dans le statut,
  ni dans `/data`.
- **Empreinte du certificat** (facultatif) : laissez-la vide. La PVS a un
  certificat autosigné : à la première connexion son empreinte est épinglée
  (gardée dans `/data`) avant l'envoi du mot de passe. Si le certificat
  change ensuite (PVS remplacée ou réinitialisée), plus rien n'est envoyé et
  le statut affiche la nouvelle empreinte : si vous lui faites confiance,
  copiez-la dans ce champ et enregistrez.

Ouvrez ensuite l'onglet **Découverte** et créez les appareils voulus.

## Ce que vous obtenez

- **Site PVS SunPower** (lu toutes les 30 secondes) :
  - **Puissance de production** (W) ;
  - **Index de production** (kWh, la production totale de la PVS, envoyé
    une fois par minute) : le suivi énergétique de Gladys en tire la
    production par demi-heure (la fonction 30 minutes est déclarée avec lui,
    Gladys la remplit) ;
  - **Puissance réseau** (W, + achetée au réseau, - vendue), **Consommation
    de la maison** (W) et **Consommation de la maison** totale (kWh, simple
    capteur, non comptée) ;
  - avec une batterie SunVault : **Puissance de la batterie** (W,
    - décharge, - charge) et **Autonomie de secours restante** (minutes).
- **Chaque micro-onduleur** (lu toutes les 5 minutes, un échantillon toutes
  les 5 minutes) : puissance de production, production totale (kWh, simple
  capteur), tension et courant alternatifs, fréquence du réseau, température
  du dissipateur, puissance, tension et courant continus du panneau.
- **Le compteur de production** de la PVS : puissance, production totale
  (simple capteur), tension, fréquence. **Le compteur de consommation** :
  puissance réseau (signée comme la PVS la donne), totaux achetés au réseau
  et vendus au réseau (kWh, simples capteurs), tensions et courants de L1 et
  L2, fréquence.
- **Chaque batterie SunVault** : état de charge (%), puissance (signée comme
  la PVS la donne), tension de la batterie, température de l'onduleur.
- **Chaque commutateur de transfert** (MIDC) : relais réseau fermé (1) ou
  ouvert (0), température, tensions du réseau.

Seul l'index de production du site entre dans le suivi énergétique. Ce que
la maison consomme ou achète au réseau est compté par votre compteur
d'électricité : compté ici aussi, il serait facturé deux fois. Les autres
totaux sont de simples capteurs, l'unité dans leur nom.

## Compteurs cumulés : la garde

Chaque compteur cumulé (l'index de production et chaque total) passe par une
garde avant d'arriver à Gladys :

- une valeur nulle ou négative n'est pas envoyée ;
- une valeur plus basse que la dernière envoyée (une baisse), ou plus haute
  que ce que le site a pu produire ou consommer depuis (200 kW en moyenne
  pour le site et ses compteurs, 2 kW pour un micro-onduleur), est
  **retenue** : non envoyée, affichée dans le statut, le badge de l'appareil
  passe à l'orange, et elle reste retenue après un redémarrage. Ni le temps
  ni la répétition ne la lèvent ;
- si elle est juste (appareil remplacé, compteur remis à zéro), cliquez deux
  fois sur **Accepter les valeurs retenues** : le premier clic liste ce qui
  est retenu, le second (de 3 secondes à 5 minutes plus tard) accepte
  exactement ce qui a été listé si cela n'a pas changé autrement. Un saut
  accepté est compté d'un coup ; une baisse acceptée ne compte rien et le
  compteur repart de là. Enregistrer la configuration n'accepte rien.

La garde mesure le temps sur l'horloge de la session de l'intégration : une
horloge remise à l'heure par le réseau (NTP) n'élargit ni ne rétrécit sa
marge.

## Fraîcheur et identité

- Chaque échantillon d'un appareil est envoyé une fois (son heure est gardée
  dans `/data` : un redémarrage ne le renvoie pas). Un échantillon de plus
  de 2 heures plus ancien que l'horloge de la PVS (son en-tête `Date`, ou
  l'heure de ses données instantanées) n'est pas envoyé ; sans horloge
  lisible de la PVS, un échantillon n'est pas tenu pour expiré.
- Chaque lecture vérifie l'adresse MAC réseau de la PVS (gardée dans
  `/data` sous forme d'empreinte salée, pas l'adresse). Si une autre PVS
  répond à l'adresse, rien n'est publié tant que vous n'avez pas cliqué
  deux fois sur **Accepter les valeurs retenues**. Une adresse MAC illisible
  ne publie rien de cette lecture.

## Statut et boutons

- **Tester la connexion** : lit la PVS une fois quand une lecture est due
  (jamais plus d'une toutes les 30 secondes), sinon donne la dernière
  lecture. Après un mot de passe refusé, il réessaie une fois ; une réussite
  lève le refus.
- Un **mot de passe refusé** arrête les lectures jusqu'à ce qu'un autre mot
  de passe soit enregistré ou que le bouton de test réussisse (gardé après un
  redémarrage).
- « Trop de requêtes » (429) ou une erreur de la PVS (5xx) sur les données
  instantanées met les lectures en pause (1 minute, doublée jusqu'à 6
  heures, gardée après un redémarrage).
- Une PVS injoignable est réessayée après 30 secondes, doublées jusqu'à 30
  minutes. Une sorte d'appareil en échec (micro-onduleurs, compteurs...) est
  réessayée après 5 minutes, doublées jusqu'à 1 heure, sans retenir les
  autres.

## Limites

- Une PVS par intégration.
- L'API locale est récente : SunStrong prévient que la liste des variables
  peut changer.
- Au plus 200 micro-onduleurs, 8 compteurs, 8 batteries, 4 commutateurs de
  transfert ; l'intégration envoie au plus 250 valeurs par minute à Gladys
  (un grand site reçoit les échantillons de ses micro-onduleurs en quelques
  minutes).
- Les signes des puissances de la batterie et des compteurs sont ceux de la
  PVS (non vérifiés sur une vraie installation).
