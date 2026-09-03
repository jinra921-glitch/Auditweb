export function requireAdmin(request, response, next) {
  if (request.session?.user?.role !== 'admin') {
    return response.status(403).json({ code: 'ADMIN_REQUIRED', error: 'Administrator access is required.' });
  }
  next();
}
