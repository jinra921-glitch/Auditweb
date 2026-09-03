import { Router } from 'express';
import * as auth from '../controllers/authController.js';
import { requireAuth, requireAuthForPasswordChange } from '../middleware/auth.js';
const router = Router();
router.post('/login', auth.login); router.post('/logout', auth.logout); router.get('/me', auth.me);
router.post('/change-password', requireAuthForPasswordChange, auth.changePassword);
export default router;
