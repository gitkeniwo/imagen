"""Series pick/reject marks and their output-image invariants (series-v2 B5)."""

MARK_KINDS = ("pick", "reject")


def for_series(conn, series_id: int) -> dict[int, str]:
    """``{image_id: kind}`` for one series."""
    return {
        row["image_id"]: row["kind"]
        for row in conn.execute(
            "SELECT image_id, kind FROM series_marks WHERE series_id = ?",
            (series_id,),
        ).fetchall()
    }


def cleanup_detached_outputs(conn, pairs) -> None:
    """Drop marks whose image is no longer an output of the original series.

    Call with the ``(series_id, image_id)`` pairs a record had before it moved
    series or changed its output. A mark survives while another record in that
    series still outputs the same image.
    """
    for series_id, image_id in set(pairs):
        if series_id is None or image_id is None:
            continue
        conn.execute(
            """DELETE FROM series_marks
               WHERE series_id = ? AND image_id = ?
                 AND NOT EXISTS (
                     SELECT 1 FROM generations g
                     WHERE g.series_id = ? AND g.output_image_id = ?
                       AND g.status != 'note'
                 )""",
            (series_id, image_id, series_id, image_id),
        )
