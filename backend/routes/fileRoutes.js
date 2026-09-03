import { Router } from 'express';
import * as files from '../controllers/fileController.js';
import { requireAuth } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
const router = Router(); router.use(requireAuth); router.get('/:collection', files.listAttachmentFolders); router.put('/:collection', files.saveAttachmentFolders); router.post('/:collection/:folderId/files', upload.single('file'), files.uploadAttachment); export default router;
