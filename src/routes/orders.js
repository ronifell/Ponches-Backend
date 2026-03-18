const { pool } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

module.exports = function registerOrderRoutes(app) {
  app.get('/orders/:orderNumber', authRequired, async (req, res) => {
    const { orderNumber } = req.params;
    const orderId = String(orderNumber);

    const [rows] = await pool.query(
      `SELECT order_number, latitude, longitude, radius_meters
       FROM customer_orders
       WHERE order_number = ? AND company_id = ?
       LIMIT 1`,
      [orderId, req.user.companyId]
    );

    const order = rows?.[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    return res.json({
      orderNumber: order.order_number,
      latitude: order.latitude,
      longitude: order.longitude,
      radiusMeters: order.radius_meters
    });
  });
};

