import 'package:flutter/material.dart';

String _fmtDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String _fmtDateTime(DateTime d) =>
    '${_fmtDate(d)} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

String fmtDate(Object? value) {
  if (value == null || value.toString().isEmpty) return '-';
  final d = DateTime.tryParse(value.toString());
  return d == null ? value.toString() : _fmtDate(d.toLocal());
}

String fmtDateTime(Object? value) {
  if (value == null) return '-';
  final d = value is DateTime ? value : DateTime.tryParse(value.toString());
  return d == null ? '-' : _fmtDateTime(d.toLocal());
}

String relativeTime(DateTime? then, {DateTime? now}) {
  if (then == null) return '-';
  final diff = (now ?? DateTime.now()).difference(then);
  if (diff.inSeconds < 45) return 'just now';
  if (diff.inMinutes < 1) return '${diff.inSeconds}s ago';
  if (diff.inHours < 1) return '${diff.inMinutes} min ago';
  if (diff.inDays < 1) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}

const kStatusColors = <String, Color>{
  'ACTIVE': Color(0xFF2E7D32),
  'REDEEMED': Color(0xFF2E7D32),
  'UNUSED': Color(0xFF1565C0),
  'BLOCKED': Color(0xFFC62828),
  'REVOKED': Color(0xFF616161),
  'EXPIRED': Color(0xFFEF6C00),
  'PENDING_KEY': Color(0xFF6A1B9A),
  'PENDING_ACTIVATION': Color(0xFF6A1B9A),
};

Color statusColor(String? status) =>
    kStatusColors[status] ?? Colors.grey.shade700;

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});

  final String? status;

  @override
  Widget build(BuildContext context) {
    final label = status ?? '-';
    final color = statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class MetricCard extends StatelessWidget {
  const MetricCard({
    super.key,
    required this.label,
    required this.value,
    required this.color,
    this.caption,
  });

  final String label;
  final String value;
  final Color color;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(label, style: Theme.of(context).textTheme.labelMedium),
            const SizedBox(height: 8),
            Text(
              value,
              style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                fontWeight: FontWeight.w700,
                color: color,
              ),
            ),
            if (caption != null) ...[
              const SizedBox(height: 4),
              Text(
                caption!,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.outline,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState(this.message, {super.key, this.icon = Icons.inbox_outlined});

  final String message;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 48, color: Theme.of(context).colorScheme.outline),
          const SizedBox(height: 12),
          Text(
            message,
            style: Theme.of(context).textTheme.bodyLarge?.copyWith(
              color: Theme.of(context).colorScheme.outline,
            ),
          ),
        ],
      ),
    );
  }
}
