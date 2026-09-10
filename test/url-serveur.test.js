import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normaliserUrlServeur } from '../src/client/url-serveur.js';

/** Raccourci : l'adresse normalisee, ou l'erreur. */
function url(brut) {
  const r = normaliserUrlServeur(brut);
  return r.ok ? r.url : `ERREUR: ${r.erreur}`;
}

describe('normaliserUrlServeur', () => {
  it('laisse passer une adresse deja correcte', () => {
    assert.equal(url('wss://abc-def.trycloudflare.com'), 'wss://abc-def.trycloudflare.com');
    assert.equal(url('ws://51.195.221.245:8787'), 'ws://51.195.221.245:8787');
  });

  it('accepte l\'adresse copiee depuis le bloc de code Discord', () => {
    // Trois accents graves de chaque cote, plus les retours a la ligne.
    assert.equal(url('`wss://abc.trycloudflare.com`'), 'wss://abc.trycloudflare.com');
    assert.equal(url('   wss://abc.trycloudflare.com \n'), 'wss://abc.trycloudflare.com');
  });

  it('accepte un espace insecable colle depuis Discord', () => {
    assert.equal(url(' wss://abc.trycloudflare.com '), 'wss://abc.trycloudflare.com');
  });

  it('convertit une adresse http(s) collee depuis le navigateur', () => {
    assert.equal(url('https://abc.trycloudflare.com'), 'wss://abc.trycloudflare.com');
    assert.equal(url('http://localhost:8787'), 'ws://localhost:8787');
  });

  it('devine le protocole quand il manque', () => {
    // Un nom de domaine a un certificat : TLS.
    assert.equal(url('abc.trycloudflare.com'), 'wss://abc.trycloudflare.com');
    // Une IP brute ou un localhost, non : sans ca l'adresse du VPS ne marchait pas.
    assert.equal(url('51.195.221.245:8787'), 'ws://51.195.221.245:8787');
    assert.equal(url('localhost:8787'), 'ws://localhost:8787');
  });

  it('enleve la barre finale', () => {
    assert.equal(url('wss://abc.trycloudflare.com/'), 'wss://abc.trycloudflare.com');
  });

  it('refuse ce qui n\'est pas une adresse', () => {
    assert.match(url(''), /^ERREUR/);
    assert.match(url('   '), /^ERREUR/);
    assert.match(url(null), /^ERREUR/);
    assert.match(url('ftp://abc.test'), /^ERREUR/);
  });
});
