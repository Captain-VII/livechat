// --------------------------------------------------------------------------
// Le tunnel : sans lui, exposer le serveur a des potes demande de copier-coller
// une adresse a la main a chaque soiree. cloudflared le fait, et son adresse
// part directement dans Discord des qu'elle est connue.
// --------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Garde le trace du dernier message d'annonce par salon, pour l'effacer avant
// d'en poster un nouveau : sinon chaque redemarrage laisse une adresse morte
// derriere lui dans Discord.
const ETAT_ANNONCES_PATH = path.join(process.cwd(), '.livechat-annonces.json');

function lireDernieresAnnonces() {
  try {
    return JSON.parse(fs.readFileSync(ETAT_ANNONCES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function ecrireDernieresAnnonces(etat) {
  try {
    fs.writeFileSync(ETAT_ANNONCES_PATH, JSON.stringify(etat, null, 2));
  } catch (erreur) {
    console.warn("[tunnel] Impossible de sauvegarder l'etat des annonces :", erreur.message);
  }
}

// Un tunnel qui tombe (coupure reseau, cloudflared qui plante, quota atteint)
// emportait tout LiveChat avec lui : le serveur continuait de tourner, mais
// plus personne ne pouvait l'atteindre et rien ne le relancait. On le
// redemarre donc, en espacant les tentatives pour ne pas marteler Cloudflare.
const RELANCE_TUNNEL_MIN_MS = 2000;
const RELANCE_TUNNEL_MAX_MS = 60000;

/**
 * @param {object} options
 * @param {number} options.port Port local du serveur.
 * @param {string} options.adresseFixe PUBLIC_URL : pas de tunnel, juste l'annonce.
 * @param {string} options.mode AUTO_TUNNEL : 'cloudflare', ou 'none' pour rien d'automatique.
 * @param {string} options.nomSalon Le salon d'annonce, pour les messages de la console.
 * @param {() => object[]} options.salonsAnnonce Les salons Discord ou poster l'adresse.
 */
export function creerTunnel({ port, adresseFixe, mode, nomSalon, salonsAnnonce }) {
  let urlPublique = null; // wss://... une fois le tunnel pret
  let botPret = false;
  let dejaAnnonce = false;
  let processusTunnel = null;
  let delaiRelanceTunnel = RELANCE_TUNNEL_MIN_MS;
  let arretDemande = false; // vrai a partir du Ctrl+C : plus rien a relancer
  let cloudflaredIntrouvable = false; // inutile de reessayer : le binaire manque

  function lancerCloudflared() {
    console.log('[tunnel] Ouverture d\'un tunnel Cloudflare...');
    processusTunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);

    // cloudflared journalise tout sur stderr, y compris l'adresse generee.
    let tampon = '';
    processusTunnel.stderr.setEncoding('utf8');
    processusTunnel.stderr.on('data', (morceau) => {
      tampon += morceau;

      if (!urlPublique) {
        const trouve = tampon.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (trouve) {
          urlPublique = trouve[0].replace(/^https:/, 'wss:');
          // Le tunnel a tenu assez longtemps pour donner une adresse : la
          // prochaine panne repart d'un delai court.
          delaiRelanceTunnel = RELANCE_TUNNEL_MIN_MS;
          console.log(`[tunnel] Adresse publique : ${urlPublique}`);
          annoncerSiPret();
        }
      }

      // On ne recopie pas tout le log de cloudflared (tres bavard) : juste ses erreurs.
      for (const ligne of morceau.split('\n')) {
        if (/\bERR\b/.test(ligne)) console.warn(`[tunnel] ${ligne.trim()}`);
      }
    });

    processusTunnel.on('error', (erreur) => {
      if (erreur.code === 'ENOENT') {
        cloudflaredIntrouvable = true;
        console.error('[tunnel] cloudflared introuvable. Installe-le avec :');
        console.error('[tunnel]   winget install --id Cloudflare.cloudflared');
        console.error("[tunnel] Ou mets AUTO_TUNNEL=none et lance ton propre tunnel a la main.");
      } else {
        console.error('[tunnel] Erreur :', erreur.message);
      }
    });

    processusTunnel.on('exit', (code) => {
      processusTunnel = null;
      if (arretDemande || cloudflaredIntrouvable) return;

      console.warn(`[tunnel] cloudflared s'est arrete (code ${code}). Relance dans ${delaiRelanceTunnel / 1000}s.`);

      // L'adresse d'un tunnel ephemere ne survit pas au processus : la prochaine
      // sera differente, donc il faudra la re-annoncer dans Discord.
      urlPublique = null;
      dejaAnnonce = false;

      setTimeout(lancerCloudflared, delaiRelanceTunnel);
      delaiRelanceTunnel = Math.min(delaiRelanceTunnel * 2, RELANCE_TUNNEL_MAX_MS);
    });
  }

  /** Poste l'adresse dans Discord des que le tunnel ET le bot sont prets. */
  async function annoncerSiPret() {
    if (dejaAnnonce || !urlPublique || !botPret) return;
    dejaAnnonce = true;

    const salons = salonsAnnonce();
    if (salons.length === 0) {
      console.warn(`[tunnel] Aucun salon #${nomSalon} trouve pour annoncer l'adresse.`);
      console.warn(`[tunnel] Donne-la a la main : ${urlPublique}`);
      return;
    }

    const etat = lireDernieresAnnonces();

    for (const salon of salons) {
      // Efface l'annonce precedente de ce salon avant d'en poster une nouvelle.
      const ancienId = etat[salon.id];
      if (ancienId) {
        try {
          const ancien = await salon.messages.fetch(ancienId);
          await ancien.delete();
        } catch {
          // Deja supprimee (par un humain, ou une purge Discord) : tant pis.
        }
      }

      try {
        const message = await salon.send(
          "**LiveChat est en ligne.** Colle cette adresse dans l'appli " +
            "(icône de la barre des tâches > *Configurer le serveur*) :\n" +
            `\`\`\`\n${urlPublique}\n\`\`\``,
        );
        etat[salon.id] = message.id;
        console.log(`[tunnel] Adresse annoncee dans #${salon.name} (${salon.guild.name}).`);
      } catch (erreur) {
        console.error(`[tunnel] Envoi impossible dans #${salon.name} :`, erreur.message);
      }
    }

    ecrireDernieresAnnonces(etat);
  }

  return {
    demarrer() {
      // Adresse fixe (VPS, domaine derriere nginx...) : pas de tunnel a ouvrir,
      // mais l'annonce automatique dans Discord reste utile telle quelle.
      if (adresseFixe) {
        urlPublique = adresseFixe;
        console.log(`[tunnel] Adresse publique fixe : ${urlPublique}`);
        annoncerSiPret();
        return;
      }

      if (mode === 'none' || mode === 'non') {
        console.log("[tunnel] AUTO_TUNNEL=none : lance le tien a la main si besoin.");
        return;
      }

      lancerCloudflared();
    },

    /** Le bot Discord est connecte : l'adresse peut partir. */
    surBotPret() {
      botPret = true;
      annoncerSiPret();
    },

    arreter() {
      arretDemande = true;
      processusTunnel?.kill();
    },
  };
}
