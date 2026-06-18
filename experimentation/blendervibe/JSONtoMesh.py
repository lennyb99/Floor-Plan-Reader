import bpy
import json
import math
import os

bl_info = {
    "name": "JSON Structural Floorplan Importer",
    "author": "AI Assistant",
    "version": (1, 2),
    "blender": (4, 0, 0),
    "location": "View3D > Add > Mesh / View3D > Sidebar",
    "description": "Generates 3D walls, doors, and windows from structural JSON data.",
    "category": "Import-Export",
}

def create_floorplan(json_path, scale, wall_height, door_height, window_height, window_sill, invert_y, img_h):
    # Load JSON data
    with open(json_path, 'r') as f:
        data = json.load(f)
        
    # Organize into a dedicated collection
    collection_name = "Generated_Floorplan"
    if collection_name in bpy.data.collections:
        col = bpy.data.collections[collection_name]
        # Clear previous generation for rapid file swapping
        for obj in col.objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    else:
        col = bpy.data.collections.new(collection_name)
        bpy.context.scene.collection.children.link(col)
        
    walls = data.get("walls", [])
    
    for wall_data in walls:
        wall_id = wall_data.get("id", "wall")
        start = wall_data["start"]
        end = wall_data["end"]
        thickness = wall_data.get("thickness", 5.0)
        
        # Extract coordinates
        x1, y1 = start["x"], start["y"]
        x2, y2 = end["x"], end["y"]
        
        # Handle Image Coordinates to Blender World Coordinates Transformation
        if invert_y:
            y1 = img_h - y1
            y2 = img_h - y2
            
        dx = x2 - x1
        dy = y2 - y1
        length = math.sqrt(dx**2 + dy**2)
        angle = math.atan2(dy, dx)
        
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        
        # 1. Create Wall Mesh
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        wall_obj = bpy.context.active_object
        wall_obj.name = wall_id
        
        # Move to the floorplan collection
        for c in wall_obj.users_collection:
            c.objects.unlink(wall_obj)
        col.objects.link(wall_obj)
        
        # Scale and Position Wall
        wall_obj.scale.x = length * scale
        wall_obj.scale.y = thickness * scale
        wall_obj.scale.z = wall_height
        
        wall_obj.location.x = cx * scale
        wall_obj.location.y = cy * scale
        wall_obj.location.z = wall_height / 2.0
        wall_obj.rotation_euler.z = angle
        
        # 2. Process Doors (Cutouts)
        for i, door in enumerate(wall_data.get("doors", [])):
            # ADJUSTMENT: Use "center" instead of "snapped_at"
            pos = door["center"]
            
            # ADJUSTMENT: Use max of "width" and "height" to find the wall-aligned dimension
            d_width = max(door.get("width", 0), door.get("height", 0))
            if d_width == 0: 
                d_width = 20.0 
            
            wx, wy = pos["x"], pos["y"]
            if invert_y: 
                wy = img_h - wy
            
            bpy.ops.mesh.primitive_cube_add(size=1.0)
            door_cutter = bpy.context.active_object
            door_cutter.name = f"{wall_id}_door_{i}_cutter"
            
            for c in door_cutter.users_collection:
                c.objects.unlink(door_cutter)
            col.objects.link(door_cutter)
            
            door_cutter.scale.x = d_width * scale
            door_cutter.scale.y = (thickness + 4.0) * scale 
            door_cutter.scale.z = door_height
            
            door_cutter.location.x = wx * scale
            door_cutter.location.y = wy * scale
            door_cutter.location.z = door_height / 2.0
            door_cutter.rotation_euler.z = angle
            
            bool_mod = wall_obj.modifiers.new(name=f"Door_{i}", type='BOOLEAN')
            bool_mod.operation = 'DIFFERENCE'
            bool_mod.object = door_cutter
            door_cutter.display_type = 'WIRE'
            
        # 3. Process Windows (Cutouts)
        for i, window in enumerate(wall_data.get("windows", [])):
            # ADJUSTMENT: Use "center" instead of "snapped_at"
            pos = window["center"]
            
            # ADJUSTMENT: Use max of "width" and "height" 
            w_width = max(window.get("width", 0), window.get("height", 0))
            if w_width == 0: 
                w_width = 30.0 
            
            wx, wy = pos["x"], pos["y"]
            if invert_y: 
                wy = img_h - wy
            
            bpy.ops.mesh.primitive_cube_add(size=1.0)
            win_cutter = bpy.context.active_object
            win_cutter.name = f"{wall_id}_window_{i}_cutter"
            
            for c in win_cutter.users_collection:
                c.objects.unlink(win_cutter)
            col.objects.link(win_cutter)
            
            win_cutter.scale.x = w_width * scale
            win_cutter.scale.y = (thickness + 4.0) * scale
            win_cutter.scale.z = window_height
            
            win_cutter.location.x = wx * scale
            win_cutter.location.y = wy * scale
            win_cutter.location.z = window_sill + (window_height / 2.0)
            win_cutter.rotation_euler.z = angle
            
            bool_mod = wall_obj.modifiers.new(name=f"Window_{i}", type='BOOLEAN')
            bool_mod.operation = 'DIFFERENCE'
            bool_mod.object = win_cutter
            win_cutter.display_type = 'WIRE'

# --- Blender UI & Operator Implementation ---

class OBJECT_OT_generate_floorplan(bpy.types.Operator):
    bl_idname = "object.generate_floorplan"
    bl_label = "Generate Floorplan Geometry"
    bl_options = {'REGISTER', 'UNDO'}
    
    def execute(self, context):
        scene = context.scene
        json_path = bpy.path.abspath(scene.floorplan_json_path)
        
        if not json_path or not os.path.exists(json_path):
            self.report({'ERROR'}, "Please specify a valid JSON file path.")
            return {'CANCELLED'}
            
        try:
            create_floorplan(
                json_path=json_path,
                scale=scene.floorplan_scale,
                wall_height=scene.floorplan_wall_height,
                door_height=scene.floorplan_door_height,
                window_height=scene.floorplan_window_height,
                window_sill=scene.floorplan_window_sill,
                invert_y=scene.floorplan_invert_y,
                img_h=scene.floorplan_img_height
            )
            self.report({'INFO'}, "Geometry generated successfully!")
            return {'FINISHED'}
        except Exception as e:
            self.report({'ERROR'}, f"Failed to build layout: {str(e)}")
            return {'CANCELLED'}

class VIEW3D_PT_floorplan_panel(bpy.types.Panel):
    bl_label = "JSON Floorplan Generator"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Floorplan'
    
    def draw(self, context):
        layout = self.layout
        scene = context.scene
        
        layout.prop(scene, "floorplan_json_path")
        
        box = layout.box()
        box.label(text="Scale & Transformations", icon='XRAY')
        box.prop(scene, "floorplan_scale")
        box.prop(scene, "floorplan_invert_y")
        if scene.floorplan_invert_y:
            box.prop(scene, "floorplan_img_height")
            
        box = layout.box()
        box.label(text="Architectural Heights (m)", icon='MOD_LENGTH')
        box.prop(scene, "floorplan_wall_height")
        box.prop(scene, "floorplan_door_height")
        box.prop(scene, "floorplan_window_height")
        box.prop(scene, "floorplan_window_sill")
        
        layout.separator()
        layout.operator("object.generate_floorplan", icon='MESH_CUBE', text="Build / Update Scene")

def menu_func(self, context):
    self.layout.separator()
    self.layout.operator("object.generate_floorplan", icon='MESH_CUBE', text="Import Floorplan JSON")

def register():
    bpy.utils.register_class(OBJECT_OT_generate_floorplan)
    bpy.utils.register_class(VIEW3D_PT_floorplan_panel)
    bpy.types.VIEW3D_MT_mesh_add.append(menu_func)
    
    bpy.types.Scene.floorplan_json_path = bpy.props.StringProperty(
        name="JSON File", subtype='FILE_PATH', description="Path to your architectural layout JSON"
    )
    # Note: Depending on your coordinates, you might need to tweak this default scale.
    bpy.types.Scene.floorplan_scale = bpy.props.FloatProperty(
        name="Scale Factor", default=0.02, min=0.0001, description="Multiplier to match real-world meters"
    )
    bpy.types.Scene.floorplan_invert_y = bpy.props.BoolProperty(
        name="Invert Y Axis", default=True, description="Enable if (0,0) is top-left"
    )
    bpy.types.Scene.floorplan_img_height = bpy.props.IntProperty(
        name="Image Resolution Height", default=512, min=1
    )
    bpy.types.Scene.floorplan_wall_height = bpy.props.FloatProperty(name="Wall Height", default=2.8, min=0.1)
    bpy.types.Scene.floorplan_door_height = bpy.props.FloatProperty(name="Door Height", default=2.1, min=0.1)
    bpy.types.Scene.floorplan_window_height = bpy.props.FloatProperty(name="Window Height", default=1.3, min=0.1)
    bpy.types.Scene.floorplan_window_sill = bpy.props.FloatProperty(name="Window Sill", default=0.9, min=0.0)

def unregister():
    bpy.utils.unregister_class(OBJECT_OT_generate_floorplan)
    bpy.utils.unregister_class(VIEW3D_PT_floorplan_panel)
    bpy.types.VIEW3D_MT_mesh_add.remove(menu_func)
    del bpy.types.Scene.floorplan_json_path
    del bpy.types.Scene.floorplan_scale
    del bpy.types.Scene.floorplan_invert_y
    del bpy.types.Scene.floorplan_img_height
    del bpy.types.Scene.floorplan_wall_height
    del bpy.types.Scene.floorplan_door_height
    del bpy.types.Scene.floorplan_window_height
    del bpy.types.Scene.floorplan_window_sill

if __name__ == "__main__":
    register()