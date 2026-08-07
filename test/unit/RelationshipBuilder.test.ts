import "reflect-metadata";
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { MetadataStorage, RelationType, CascadeOption } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

@Entity('rb_departments')
class RbDepartment {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    employees!: RbEmployee[];
}

@Entity('rb_employees')
class RbEmployee {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    departmentid!: number;

    department!: RbDepartment;
    projects!: RbProject[];
}

@Entity('rb_projects')
class RbProject {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    members!: RbEmployee[];
}

function relations(entityType: any) {
    return MetadataStorage.get().getEntity(entityType)!.relations;
}

describe('ModelBuilder relationship configuration', () => {
    const builder = new ModelBuilder();

    it('hasOne() registers a many-to-one relation with foreign key and inverse side', () => {
        builder.entity(RbEmployee)
            .hasOne(e => e.department, RbDepartment)
            .hasForeignKey('departmentid')
            .withMany(d => d.employees)
            .onDelete(CascadeOption.Cascade)
            .onUpdate(CascadeOption.NoAction);

        const relation = relations(RbEmployee).find(r => r.propertyName === 'department')!;
        expect(relation.relationType).toBe(RelationType.ManyToOne);
        expect(relation.relatedEntity()).toBe(RbDepartment);
        expect(relation.foreignKeyColumn).toBe('departmentid');
        expect(relation.inverseSide).toBe('employees');
        expect(relation.onDelete).toBe(CascadeOption.Cascade);
        expect(relation.onUpdate).toBe(CascadeOption.NoAction);
    });

    it('hasMany() registers a one-to-many relation with inverse side', () => {
        builder.entity(RbDepartment)
            .hasMany(d => d.employees, RbEmployee)
            .withMany(e => e.department);

        const relation = relations(RbDepartment).find(r => r.propertyName === 'employees')!;
        expect(relation.relationType).toBe(RelationType.OneToMany);
        expect(relation.relatedEntity()).toBe(RbEmployee);
        expect(relation.inverseSide).toBe('department');
    });

    it('hasManyToMany() derives default join table and key columns', () => {
        builder.entity(RbEmployee).hasManyToMany(e => e.projects, RbProject);

        const relation = relations(RbEmployee).find(r => r.propertyName === 'projects')!;
        expect(relation.relationType).toBe(RelationType.ManyToMany);
        expect(relation.joinTable).toBe('rbemployee_rbproject');
        expect(relation.joinColumn).toBe('rbemployeeId');
        expect(relation.inverseJoinColumn).toBe('rbprojectId');
    });

    it('usingJoinTable() overrides join table and key columns', () => {
        builder.entity(RbProject)
            .hasManyToMany(p => p.members, RbEmployee)
            .usingJoinTable('rb_project_members', 'project_id', 'employee_id');

        const relation = relations(RbProject).find(r => r.propertyName === 'members')!;
        expect(relation.joinTable).toBe('rb_project_members');
        expect(relation.joinColumn).toBe('project_id');
        expect(relation.inverseJoinColumn).toBe('employee_id');
    });

    it('does not duplicate a relation configured twice', () => {
        builder.entity(RbEmployee).hasOne(e => e.department, RbDepartment);
        builder.entity(RbEmployee).hasOne(e => e.department, RbDepartment);

        const matches = relations(RbEmployee).filter(r => r.propertyName === 'department');
        expect(matches).toHaveLength(1);
    });
});
