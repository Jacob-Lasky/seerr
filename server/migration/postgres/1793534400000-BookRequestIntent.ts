import {
  TableColumn,
  type MigrationInterface,
  type QueryRunner,
} from 'typeorm';

export class BookRequestIntent1793534400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'media_request',
      new TableColumn({
        name: 'bookRequestIntent',
        type: 'text',
        isNullable: true,
      })
    );
    // BEFORE DELETE also runs for FK cascades. The row lock serializes with
    // intent preparation/claim; no check-then-delete window or parent bypass.
    await queryRunner.query(`
      CREATE FUNCTION book_request_intent_delete_hold() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD."bookRequestIntent" IS NOT NULL THEN
          RAISE EXCEPTION 'BOOK_REQUEST_INTENT_DELETE_HELD';
        END IF;
        RETURN OLD;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER book_request_intent_delete_hold
      BEFORE DELETE ON media_request
      FOR EACH ROW EXECUTE FUNCTION book_request_intent_delete_hold()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const ownTransaction = !queryRunner.isTransactionActive;
    if (ownTransaction) await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        'LOCK TABLE media_request IN ACCESS EXCLUSIVE MODE'
      );
      // Keep the check and schema removal in one transaction. SQLite retains its
      // read lock through the DDL; PostgreSQL explicitly excludes concurrent writes.
      const held = await queryRunner.query(
        'SELECT 1 FROM media_request WHERE "bookRequestIntent" IS NOT NULL LIMIT 1'
      );
      if (held.length) throw new Error('BOOK_REQUEST_INTENT_ROLLBACK_HELD');
      await queryRunner.query(
        'DROP TRIGGER book_request_intent_delete_hold ON media_request'
      );
      await queryRunner.query(
        'DROP FUNCTION book_request_intent_delete_hold()'
      );
      await queryRunner.dropColumn('media_request', 'bookRequestIntent');
      if (ownTransaction) await queryRunner.commitTransaction();
    } catch (error) {
      if (ownTransaction && queryRunner.isTransactionActive)
        await queryRunner.rollbackTransaction();
      throw error;
    }
  }
}
