import { Router } from 'express';
import * as users from '../controllers/userController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';

const router = Router();
router.use(requireAuth, requireAdmin);
router.get('/', users.listUsers);
router.post('/', users.createUser);
router.patch('/:username', users.updateUser);
router.delete('/:username', users.deleteUser);
export default router;
