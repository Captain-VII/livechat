import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dureeDepuisMvhd,
  extensionOf,
  findMediaUrl,
  mediaDesEmbeds,
  mediaTypeOf,
  urlsDe,
} from '../src/medias.js';

describe('extensionOf', () => {
  it("ignore les query params signes des CDN Discord", () => {
    assert.equal(
      extensionOf('https://cdn.discordapp.com/attachments/1/2/chat.PNG?ex=abc&is=def&hm=123'),
      '.png',
    );
  });

  it('rend une chaine vide sur une URL invalide', () => {
    assert.equal(extensionOf('pas une url'), '');
    assert.equal(extensionOf(undefined), '');
  });
});

describe('mediaTypeOf', () => {
  it('fait confiance au content-type avant tout', () => {
    // Une piece jointe Discord sans extension parlante : seul le content-type sait.
    assert.equal(mediaTypeOf('https://x.test/fichier', 'video/mp4'), 'video');
    assert.equal(mediaTypeOf('https://x.test/fichier.mp4', 'image/png'), 'image');
  });

  it("retombe sur l'extension quand le content-type manque", () => {
    assert.equal(mediaTypeOf('https://x.test/a.webm'), 'video');
    assert.equal(mediaTypeOf('https://x.test/a.gif'), 'image');
  });

  it('rend null sur ce qui ne s\'affiche pas', () => {
    assert.equal(mediaTypeOf('https://x.test/page.html'), null);
    assert.equal(mediaTypeOf('https://tenor.com/view/un-gif-123'), null);
  });
});

describe('urlsDe / findMediaUrl', () => {
  it('trouve toutes les URL d\'un message', () => {
    assert.deepEqual(urlsDe('regarde https://a.test/x.png et http://b.test/y'), [
      'https://a.test/x.png',
      'http://b.test/y',
    ]);
  });

  it('supporte un message vide', () => {
    assert.deepEqual(urlsDe(null), []);
    assert.equal(findMediaUrl(null), null);
  });

  it('retient la premiere URL qui pointe vraiment sur un media', () => {
    assert.equal(
      findMediaUrl('https://exemple.test/article puis https://exemple.test/chat.jpg'),
      'https://exemple.test/chat.jpg',
    );
  });
});

describe('mediaDesEmbeds', () => {
  it('prefere la video a l\'image et a la vignette', () => {
    const embeds = [{ video: { url: 'https://x.test/a.mp4' }, thumbnail: { url: 'https://x.test/a.png' } }];
    assert.deepEqual(mediaDesEmbeds(embeds), { mediaUrl: 'https://x.test/a.mp4', mediaType: 'video' });
  });

  it('tombe sur la vignette quand c\'est tout ce que Discord a resolu', () => {
    const embeds = [{ thumbnail: { url: 'https://media.tenor.com/abc.gif' } }];
    assert.deepEqual(mediaDesEmbeds(embeds), {
      mediaUrl: 'https://media.tenor.com/abc.gif',
      mediaType: 'image',
    });
  });

  it('rend null quand rien n\'est affichable', () => {
    assert.equal(mediaDesEmbeds([{ title: 'un article' }]), null);
    assert.equal(mediaDesEmbeds(undefined), null);
  });
});

describe('dureeDepuisMvhd', () => {
  /** Fabrique une boite mvhd version 0 : timescale et duree sur 32 bits. */
  function mvhdV0(timescale, duration) {
    const buf = Buffer.alloc(64);
    buf.write('mvhd', 8);
    buf.writeUInt8(0, 12); // version
    buf.writeUInt32BE(timescale, 8 + 16);
    buf.writeUInt32BE(duration, 8 + 20);
    return buf;
  }

  /** Fabrique une boite mvhd version 1 : duree sur 64 bits. */
  function mvhdV1(timescale, duration) {
    const buf = Buffer.alloc(80);
    buf.write('mvhd', 8);
    buf.writeUInt8(1, 12); // version
    buf.writeUInt32BE(timescale, 8 + 24);
    buf.writeBigUInt64BE(BigInt(duration), 8 + 28);
    return buf;
  }

  it('lit une duree en version 0', () => {
    assert.equal(dureeDepuisMvhd(mvhdV0(1000, 7500)), 7.5);
  });

  it('lit une duree en version 1', () => {
    assert.equal(dureeDepuisMvhd(mvhdV1(600, 1800)), 3);
  });

  it("rend null quand la boite mvhd n'est pas la", () => {
    assert.equal(dureeDepuisMvhd(Buffer.from('pas un mp4 du tout')), null);
  });

  it('rend null sur un timescale a zero plutot que de diviser par zero', () => {
    assert.equal(dureeDepuisMvhd(mvhdV0(0, 1000)), null);
  });

  it('rend null si la boite est tronquee', () => {
    const tronque = mvhdV0(1000, 5000).subarray(0, 14);
    assert.equal(dureeDepuisMvhd(tronque), null);
  });
});
