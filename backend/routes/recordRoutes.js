import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as records from '../controllers/recordController.js';

const router = Router();
router.use(requireAuth);
router.get('/', records.listRecords);
router.post('/', records.createRecord);
router.get('/:recordId', records.getRecord);
router.put('/:recordId', records.updateRecord);
router.delete('/:recordId', records.deleteRecord);
export default router;
