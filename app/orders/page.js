'use client';

import { useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';

function SkeletonOrderCard() {
  return (
    <div className="skeleton-card">
      <div className="order-card-image skeleton" />
      <div className="skeleton-line skeleton" />
      <div className="skeleton-line short skeleton" />
    </div>
  );
}

export default function OrdersPage() {
  const { orders, ordersError } = useDashboard();
  const [fSource, setFSource] = useState('all');

  const now = Date.now();
  const visibleOrders = (orders || []).filter(
    (o) => (fSource === 'all' || o.source === fSource) && !(o.shipByMs && o.shipByMs < now)
  );

  return (
    <>
      <div className="section-title">
        <h2>Open orders</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select value={fSource} onChange={(e) => setFSource(e.target.value)} aria-label="Filter by platform">
            <option value="all">All platforms</option>
            <option value="myntra">Myntra</option>
            <option value="amazon">Amazon</option>
          </select>
          <span className="muted">
            {orders ? `${visibleOrders.length} order${visibleOrders.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
      </div>

      {ordersError && <div className="banner bad">{ordersError}</div>}

      {orders === null && !ordersError && (
        <div className="order-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonOrderCard key={i} />
          ))}
        </div>
      )}

      {orders && visibleOrders.length === 0 && !ordersError && (
        <div className="card empty-state">No open orders right now.</div>
      )}

      {orders && visibleOrders.length > 0 && (
        <div className="order-grid">
          {visibleOrders.map((order) => {
            const isMulti = order.items.length > 1;
            const solo = order.items[0];
            return (
              <div className="order-card" key={`${order.source}-${order.orderId}`}>
                {!isMulti && (solo?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="order-card-image" src={solo.image} alt={solo.name || 'Product'} />
                ) : (
                  <div className="order-card-image" />
                ))}
                <div className="order-card-body">
                  <div className="order-card-toprow">
                    <span className={`source-tag ${order.source}`}>{order.source === 'amazon' ? 'Amazon' : 'Myntra'}</span>
                    {isMulti && <span className="multi-badge">Multi order</span>}
                  </div>

                  {isMulti ? (
                    <div className="order-item-list">
                      {order.items.map((item, i) => (
                        <div className="order-item-row" key={i}>
                          {item.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="order-item-thumb" src={item.image} alt={item.name || 'Product'} />
                          ) : (
                            <div className="order-item-thumb" />
                          )}
                          <div className="order-item-info">
                            <div className="order-card-name">{item.name || 'Unnamed product'}</div>
                            <div className="order-card-meta">
                              {item.size ? `Size ${item.size}` : ''}
                              {item.color ? ` · ${item.color}` : ''}
                            </div>
                            {item.sku && <span className="sku-tag">{item.sku}</span>}
                            {item.qty > 1 && <span className="sku-tag qty-tag">×{item.qty}</span>}
                            {item.stock && (
                              <div className={`stock-line ${item.stock.level}`}>
                                {item.stock.level === 'out' ? 'OUT OF STOCK' : `Stock: ${item.stock.label}`}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : solo ? (
                    <>
                      <div className="order-card-name">{solo.name || 'Unnamed product'}</div>
                      <div className="order-card-meta">
                        {solo.size ? `Size ${solo.size}` : ''}
                        {solo.color ? ` · ${solo.color}` : ''}
                      </div>
                      {solo.sku && <span className="sku-tag">{solo.sku}</span>}
                      {solo.qty > 1 && <span className="sku-tag qty-tag">×{solo.qty}</span>}
                      {solo.stock && (
                        <div className={`stock-line ${solo.stock.level}`}>
                          {solo.stock.level === 'out' ? 'OUT OF STOCK' : `Stock: ${solo.stock.label}`}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="order-card-name">Order #{order.orderId}</div>
                      <div className="order-card-meta">Qty {order.quantity ?? '?'}</div>
                    </>
                  )}

                  {order.shipByMs && (
                    <div className="order-card-meta">Ship by {new Date(order.shipByMs).toLocaleDateString()}</div>
                  )}
                  <div className="order-card-footer">
                    <span>#{order.orderId}</span>
                    <span>{order.orderDateMs ? new Date(order.orderDateMs).toLocaleDateString() : ''}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
