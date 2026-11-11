-- Revisar y aplicar en el entorno autorizado antes de publicar.
-- Acceso de solo lectura: cliente a sus solicitudes, administrador a todas.
grant select on public.urgent_request_notifications to authenticated;
create policy "urgent_history_customer_read" on public.urgent_request_notifications
for select to authenticated
using (
 user_id = (select auth.uid())
 and exists (
   select 1 from public.profiles p
   where p.id = (select auth.uid()) and p.role = 'customer'
     and p.company_id = urgent_request_notifications.company_id
 )
);
create policy "urgent_history_admin_read" on public.urgent_request_notifications
for select to authenticated
using (
 exists (
   select 1 from public.profiles p
   where p.id = (select auth.uid()) and p.role = 'admin'
 )
);
