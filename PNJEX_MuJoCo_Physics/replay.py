"""Replay a saved physics trajectory. This does not run a new grasp test."""
from pathlib import Path
import argparse, json, time
import numpy as np
import mujoco

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'outputs/PNJEX_MuJoCo_Physics' if HERE.name=='mujoco_physics' else HERE

def prepare(case):
    result=json.loads((OUT/'results'/f'{case}.json').read_text(encoding='utf-8'))
    trace=np.load(OUT/'results'/f'{case}_trajectory.npz')
    shape=result['object']['shape']
    model=mujoco.MjModel.from_xml_path(str(OUT/'models'/f'PNJEX_{shape}_replay_full.xml'))
    data=mujoco.MjData(model)
    if trace['qpos'].shape[1]!=model.nq: raise ValueError('Trajectory / model mismatch')
    # Only stored positions are replayed. Contacts are not re-solved for display.
    model.opt.disableflags |= int(mujoco.mjtDisableBit.mjDSBL_CONTACT)
    model.opt.disableflags |= int(mujoco.mjtDisableBit.mjDSBL_EQUALITY)
    opt=mujoco.MjvOption();opt.geomgroup[3:]=0
    camera=mujoco.MjvCamera();mujoco.mjv_defaultCamera(camera)
    camera.lookat[:]=[.12,-.025,.12];camera.distance=.58
    camera.azimuth=135;camera.elevation=-18
    return result,trace,model,data,opt,camera

def pose(model,data,qpos):
    data.qpos[:]=qpos;data.qvel[:]=0
    mujoco.mj_forward(model,data)

def render(case):
    from PIL import Image, ImageDraw, ImageFont
    result,trace,model,data,opt,camera=prepare(case)
    fontpath=Path('C:/Windows/Fonts/arial.ttf')
    font=ImageFont.truetype(str(fontpath),19) if fontpath.exists() else ImageFont.load_default()
    small=ImageFont.truetype(str(fontpath),15) if fontpath.exists() else ImageFont.load_default()
    media=OUT/'media';media.mkdir(exist_ok=True)
    frames=[]
    times=trace['time'];indices=list(range(0,len(times),3))
    if indices[-1]!=len(times)-1:indices.append(len(times)-1)
    with mujoco.Renderer(model,height=600,width=800,max_geom=10000) as renderer:
        for index in indices:
            pose(model,data,trace['qpos'][index]);renderer.update_scene(data,camera,scene_option=opt)
            im=Image.fromarray(renderer.render());draw=ImageDraw.Draw(im)
            draw.rectangle((0,0,800,62),fill=(18,24,32))
            t=float(times[index]);phase='PREPOSITIONED CLOSING' if t<2.5 else ('FREE RELEASE' if t<3 else ('LIFT' if t<5 else 'FREE HOLD'))
            draw.text((14,7),f'P.N.J.E.X | 100 g {result["object"]["shape"]} | {t:.2f} s | {phase}',font=font,fill='white')
            draw.text((14,34),'Recorded MuJoCo dynamics | assumed parameters | not a physical validation',font=small,fill=(211,222,234))
            frames.append(im)
        for target in [2.4,3.,5.,7.9]:
            index=int(np.argmin(abs(times-target)))
            pose(model,data,trace['qpos'][index]);renderer.update_scene(data,camera,scene_option=opt)
            Image.fromarray(renderer.render()).save(media/f'{case}_{target:g}s.png')
    frames[0].save(media/f'{case}.gif',save_all=True,append_images=frames[1:],duration=120,loop=0,optimize=False)
    print(json.dumps({'case':case,'frames':len(frames),'kind':'stored integrated trajectory replay','media':str(media)}),flush=True)

def view(case,loops=0):
    import mujoco.viewer
    result,trace,model,data,opt,camera=prepare(case)
    print(f'Replaying {case}: {result["status"]}. Close the viewer to exit.')
    with mujoco.viewer.launch_passive(model,data) as viewer:
        viewer.cam.lookat[:]=camera.lookat;viewer.cam.distance=camera.distance
        viewer.cam.azimuth=camera.azimuth;viewer.cam.elevation=camera.elevation
        viewer.opt.geomgroup[:]=opt.geomgroup
        count=0
        while viewer.is_running() and (loops==0 or count<loops):
            started=time.monotonic()
            for t,q in zip(trace['time'],trace['qpos']):
                if not viewer.is_running():return
                pose(model,data,q);viewer.sync()
                time.sleep(max(0.,started+float(t)-time.monotonic()))
            count+=1

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--case',default='cylinder_sweep_w12_mu05');ap.add_argument('--render',action='store_true');ap.add_argument('--check',action='store_true');ap.add_argument('--loops',type=int,default=0)
    args=ap.parse_args()
    if args.check:
        r,t,m,d,o,c=prepare(args.case);pose(m,d,t['qpos'][-1]);print(json.dumps({'case':args.case,'nq':m.nq,'finite':bool(np.isfinite(d.geom_xpos).all()),'trace_samples':len(t['time'])}))
    elif args.render: render(args.case)
    else:view(args.case,args.loops)
