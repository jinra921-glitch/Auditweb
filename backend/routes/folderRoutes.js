import { Router } from 'express';
import * as folders from '../controllers/folderController.js';
import { requireAuth } from '../middleware/auth.js';
import { spreadsheetUpload } from '../middleware/upload.js';

const router = Router();
router.use(requireAuth);
router.get('/', folders.listFolders);
router.post('/', folders.createFolder);
router.post('/:folderId/files', spreadsheetUpload.single('file'), folders.uploadFolderFile);
router.get('/:folderId', folders.getFolder);
router.put('/:folderId', folders.saveFolder);
router.delete('/:folderId', folders.removeFolder);
export default router;
