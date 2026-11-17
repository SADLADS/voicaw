const express = require('express');
const { authenticateJWT } = require('../auth');
const { withActionErrors, ActionError } = require('../actionError');
const imports = require('../guildImports');

// History imports (guildImports.js, docs/guilds.md History imports). Managing them needs the
// owner or Administrator in the guild, and Settings → Admin's History imports on; anyone can
// see and undo what links them (Settings → Privacy → Imported messages).
const router = express.Router();

// Loads req.member (an importer of guild :guildId) and req.importId (when given).
const importer = withActionErrors(async (req, res, next) => {
  req.member = await imports.requireImporter(Number(req.params.guildId), req.user.id);
  if (req.params.importId != null) req.importId = Number(req.params.importId);
  next();
});

const id = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ActionError(400, 'Invalid id');
  return n;
};

router.get('/guilds/:guildId/imports', authenticateJWT, importer, withActionErrors(async (req, res) => {
  res.json(await imports.listImports(req.member));
}));

router.post('/guilds/:guildId/imports', authenticateJWT, importer, withActionErrors(async (req, res) => {
  res.status(201).json(await imports.createImport(req.member, req.body ?? {}));
}));

router.get('/guilds/:guildId/imports/:importId', authenticateJWT, importer, withActionErrors(async (req, res) => {
  const view = await imports.importView(req.importId);
  if (!view?.id || view.guild_id !== req.member.guild.id) throw new ActionError(404, 'Import not found');
  res.json(view);
}));

router.put('/guilds/:guildId/imports/:importId/mapping', authenticateJWT, importer, withActionErrors(async (req, res) => {
  res.json(await imports.setMapping(req.member, req.importId, req.body ?? {}));
}));

router.post('/guilds/:guildId/imports/:importId/messages', authenticateJWT, importer, withActionErrors(async (req, res) => {
  res.json(await imports.addMessages(req.member, req.importId, req.body ?? {}));
}));

// { sourceIds } -> those already imported.
router.post('/guilds/:guildId/imports/:importId/known', authenticateJWT, importer, withActionErrors(async (req, res) => {
  res.json({ known: await imports.knownMessages(req.member, req.importId, req.body?.sourceIds) });
}));

router.post('/guilds/:guildId/imports/:importId/files', authenticateJWT, importer, withActionErrors(async (req, res) => {
  res.status(201).json(await imports.prepareImportFile(req.member, req.importId, req.body ?? {}));
}));

// An author's picture from the archive, as the file itself (8 MB at most).
router.put(
  '/guilds/:guildId/imports/:importId/authors/:authorId/avatar',
  authenticateJWT,
  express.raw({ type: () => true, limit: imports.LIMITS.avatar }),
  importer,
  withActionErrors(async (req, res) => {
    res.json(await imports.storeAuthorAvatar(req.member, req.importId, id(req.params.authorId), req.body));
  })
);

router.post('/guilds/:guildId/imports/:importId/finish', authenticateJWT, importer, withActionErrors(async (req, res) => {
  res.json(await imports.finishImport(req.member, req.importId));
}));

router.delete('/guilds/:guildId/imports/:importId', authenticateJWT, importer, withActionErrors(async (req, res) => {
  await imports.deleteImport(req.member, req.importId);
  res.json({ success: true });
}));

// ---- The person linked (Settings → Privacy, and "This wasn't me") ----

router.get('/guild-imports/me', authenticateJWT, withActionErrors(async (req, res) => {
  res.json(await imports.linkedTo(req.user.id));
}));

router.post('/guild-imports/me/unlink-all', authenticateJWT, withActionErrors(async (req, res) => {
  res.json(await imports.unlink(req.user.id));
}));

router.post('/guild-imports/authors/:authorId/unlink', authenticateJWT, withActionErrors(async (req, res) => {
  res.json(await imports.unlink(req.user.id, id(req.params.authorId)));
}));

module.exports = router;
