// The Hunspell dictionaries the checker can use (wooorm's dictionary-* packages, MIT and BSD),
// self-hosted with the app: fetched by the spellcheck worker the first time an editor needs
// one, never from a third party. Each is about 550 KB. utils/spellcheck.js lists the
// languages people can choose.
import enGbAff from '@dictionaries/en-GB/index.aff?url';
import enGbDic from '@dictionaries/en-GB/index.dic?url';
import enUsAff from '@dictionaries/en-US/index.aff?url';
import enUsDic from '@dictionaries/en-US/index.dic?url';

export const DICTIONARIES = {
  'en-GB': { aff: enGbAff, dic: enGbDic },
  'en-US': { aff: enUsAff, dic: enUsDic },
};
